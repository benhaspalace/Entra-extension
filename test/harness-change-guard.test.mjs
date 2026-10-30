import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changeViolations,
  checkChanges,
  testCases,
} from '../scripts/harness/change-guard.mjs';

const issue = { title: 'Improve group view', body: '' };
const change = (before, after, path = 'test/example.test.ts') => ({
  path,
  before,
  after,
});
const declarations = (text) => testCases('example.test.ts', text);
const cases = (text) => declarations(text).map(({ title }) => title);
let directory;

afterEach(() => {
  vi.restoreAllMocks();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('test declaration inspection', () => {
  it('finds modifiers, aliases, parameterized and todo declarations', () => {
    expect(
      cases(`
      import { it as check, test as verify } from 'vitest';
      import scenario from 'node:test';
      it('plain', () => {});
      test.skip('skipped', () => {});
      test.concurrent.only('concurrent', () => {});
      it.each([1, 2])('rows %s', () => {});
      test.each\`value
        \${1}\`('table', () => {});
      test.runIf(true)('conditional', () => {});
      it.for([1, 2])('for rows', () => {});
      check('alias', () => {});
      verify.todo('todo');
      scenario('node default', () => {});
    `),
    ).toEqual([
      'plain',
      'skipped',
      'concurrent',
      'rows %s',
      'table',
      'conditional',
      'for rows',
      'alias',
      'todo',
      'node default',
    ]);
  });

  it('ignores comments, strings and unrelated methods', () => {
    expect(
      cases(`
      // it('comment', () => {});
      const sample = "test('string', () => {})";
      service.test('unrelated');
      describe('suite', () => { it('real', () => {}); });
    `),
    ).toEqual(['real']);
  });

  it('normalizes quotes and expressions while preserving duplicate titles', () => {
    expect(
      cases(`it("same", () => {}); it('same', () => {});
      test( label + ' suffix', () => {});`),
    ).toEqual(['same', 'same', "label + ' suffix'"]);
  });

  it('fails explicitly when test syntax cannot be inspected', () => {
    expect(() => cases(`it('broken', () => {`)).toThrow(/invalid syntax/);
  });

  it('records modifier chains, conditions and inherited suite modifiers', () => {
    expect(
      declarations(`
        import { describe as group, it as check } from 'vitest';
        group.skip.each([1])('outer', () => {
          describe.runIf(enabled)('inner', () => {
            check.concurrent.only.skipIf(disabled)('case', () => {});
          });
        });
      `),
    ).toEqual([
      {
        title: 'case',
        modifiers: [
          { name: 'skip' },
          { name: 'each' },
          { name: 'runIf', condition: 'enabled' },
          { name: 'concurrent' },
          { name: 'only' },
          { name: 'skipIf', condition: 'disabled' },
        ],
      },
    ]);
  });

  it('records literal, conditional and inherited options without leaking to siblings', () => {
    expect(
      declarations(`
        describe('suite', { skip: true, only: false }, () => {
          it('nested', { 'todo': pending }, () => {});
        });
        test('sibling', { skip, ['only']: focused }, () => {});
      `),
    ).toEqual([
      {
        title: 'nested',
        modifiers: [{ name: 'skip' }, { name: 'todo', condition: 'pending' }],
      },
      {
        title: 'sibling',
        modifiers: [
          { name: 'skip', condition: 'skip' },
          { name: 'only', condition: 'focused' },
        ],
      },
    ]);
  });
});

describe('change policy', () => {
  it.each(
    ['vitest', 'node:test'].flatMap((module) =>
      ['skip', 'todo', 'only'].flatMap((modifier) =>
        ['true', 'condition'].flatMap((value) =>
          ['it', 'test', 'describe', 'suite'].map((declaration) => ({
            module,
            modifier,
            value,
            declaration,
          })),
        ),
      ),
    ),
  )(
    'rejects $module $declaration options { $modifier: $value }',
    ({ module, modifier, value, declaration }) => {
      const imports = `import { it, test, describe, suite } from '${module}';`;
      const options = `{ ${modifier}: ${value} }`;
      const after = ['describe', 'suite'].includes(declaration)
        ? `${declaration}('group', ${options}, () => { it('existing', () => {}); });`
        : `${declaration}('existing', ${options}, () => {});`;
      expect(
        changeViolations(
          [
            change(
              `${imports} it('existing', () => {});`,
              `${imports} ${after}`,
            ),
          ],
          issue,
        ),
      ).toEqual([
        expect.stringContaining('disabled or restricted test case "existing"'),
      ]);
    },
  );

  it.each(['vitest', 'node:test'])(
    'allows false, preserved and broadened options for %s',
    (module) => {
      const imports = `import { it, describe } from '${module}';`;
      for (const modifier of ['skip', 'todo', 'only']) {
        for (const [before, after] of [
          [
            `it('existing', () => {});`,
            `describe('group', { ${modifier}: false }, () => {
              it('existing', { ${modifier}: false }, () => {});
            });`,
          ],
          [
            `it('existing', { ${modifier}: condition }, () => {});`,
            `it("existing", { ${modifier}: condition }, () => {});`,
          ],
          [
            `it('existing', { ${modifier}: true }, () => {});`,
            `it('existing', () => {});`,
          ],
        ])
          expect(
            changeViolations(
              [change(`${imports} ${before}`, `${imports} ${after}`)],
              issue,
            ),
          ).toEqual([]);
      }
    },
  );

  it('rejects changing an options execution condition', () => {
    expect(
      changeViolations(
        [
          change(
            `it('existing', { skip: first }, () => {});`,
            `it('existing', { skip: second }, () => {});`,
          ),
        ],
        issue,
      ),
    ).toEqual([
      expect.stringContaining('disabled or restricted test case "existing"'),
    ]);
  });

  it.each([
    `it.only('new', () => {});`,
    `describe.only('new suite', () => { it('new', () => {}); });`,
    `describe.only('empty suite', () => {});`,
    `it('new', { only: true }, () => {});`,
    `describe('new suite', { only: true }, () => { it('new', () => {}); });`,
    `suite('empty suite', { only: true }, () => {});`,
    `test('new', { only: focused }, () => {});`,
  ])(
    'rejects introducing exclusivity through an added declaration: %s',
    (added) => {
      expect(
        changeViolations(
          [change(`it('a', () => {});`, `it('a', () => {}); ${added}`)],
          issue,
        ),
      ).toEqual([expect.stringContaining('introducing only')]);
    },
  );

  it('allows preserved exclusivity and false only options on added cases', () => {
    for (const [before, after] of [
      [
        `it('a', () => {}); it.only('focused', () => {});`,
        `it('a', () => {}); it.only('focused', () => {}); it('new', () => {});`,
      ],
      [
        `it('a', () => {});`,
        `it('a', () => {}); it('new', { only: false }, () => {});`,
      ],
    ])
      expect(changeViolations([change(before, after)], issue)).toEqual([]);
  });

  it.each([
    `it.skip('existing', () => {});`,
    `it.todo('existing');`,
    `test.skipIf(true)('existing', () => {});`,
    `test.runIf(false)('existing', () => {});`,
    `test.skipIf(condition)('existing', () => {});`,
    `test.runIf(condition)('existing', () => {});`,
    `it.only('existing', () => {});`,
    `it['skip']('existing', () => {});`,
    `it.skip.each([1])('existing', () => {});`,
    `test.each\`value\n\${1}\`.skip('existing', () => {});`,
    `describe.skip('suite', () => { it('existing', () => {}); });`,
    `describe('outer', () => {
      describe.skip('inner', () => { it('existing', () => {}); });
    });`,
    `describe.skipIf(true)('suite', () => { it('existing', () => {}); });`,
    `describe.todo('suite', () => { it('existing', () => {}); });`,
    `describe.only('suite', () => { it('existing', () => {}); });`,
    `suite.runIf(false)('suite', () => { it('existing', () => {}); });`,
    `import { describe as group, test as check } from 'vitest';
      group.skip('suite', () => { check('existing', () => {}); });`,
    `import { describe as group, it as check } from '@jest/globals';
      group.skip('suite', () => { check.todo('existing'); });`,
    `import { describe as group, test as check } from 'node:test';
      group.skip('suite', () => { check('existing', () => {}); });`,
  ])('rejects disabling or restricting an existing case: %s', (after) => {
    expect(
      changeViolations([change(`it('existing', () => {});`, after)], issue),
    ).toEqual([
      expect.stringContaining('disabled or restricted test case "existing"'),
    ]);
  });

  it.each([
    [`it('existing', () => {});`, `it.skipIf(false)('existing', () => {});`],
    [`it('existing', () => {});`, `it.runIf(true)('existing', () => {});`],
    [`it('existing', () => {});`, `it.concurrent('existing', () => {});`],
    [`it.skip('existing', () => {});`, `it('existing', () => {});`],
    [`it.todo('existing');`, `it('existing', () => {});`],
    [`it.only('existing', () => {});`, `it('existing', () => {});`],
    [
      `it.skipIf(condition)('existing', () => {});`,
      `it.skipIf( condition )("existing", () => {});`,
    ],
    [
      `describe.skip('suite', () => { it('existing', () => {}); });`,
      `it.skip('existing', () => {});`,
    ],
    [
      `it('existing', () => {});`,
      `describe.skipIf(false)('suite', () => { it('existing', () => {}); });`,
    ],
  ])('allows preserved or broadened execution: %s -> %s', (before, after) => {
    expect(changeViolations([change(before, after)], issue)).toEqual([]);
  });

  it('rejects changing a conditional execution guard', () => {
    expect(
      changeViolations(
        [
          change(
            `it.runIf(true)('existing', () => {});`,
            `it.runIf(false)('existing', () => {});`,
          ),
          change(
            `it.skipIf(first)('conditional', () => {});`,
            `it.skipIf(second)('conditional', () => {});`,
          ),
        ],
        issue,
      ),
    ).toHaveLength(2);
  });

  it('does not leak suite modifiers into sibling cases', () => {
    const text = `describe.skip('suite', () => { it('skipped', () => {}); });
      it('existing', () => {});`;
    expect(
      changeViolations(
        [change(text, text.replace(`it('existing'`, `it.skip('existing'`))],
        issue,
      ),
    ).toEqual([
      expect.stringContaining('disabled or restricted test case "existing"'),
    ]);
  });

  it('cannot hide a disabled duplicate behind an already skipped case', () => {
    const before = `it('same', () => {}); it.skip('same', () => {});`;
    const after = `it.skip('same', () => {}); it.skip('same', () => {});`;
    expect(changeViolations([change(before, after)], issue)).toEqual([
      expect.stringContaining('disabled or restricted test case "same"'),
    ]);
    expect(
      changeViolations(
        [change(before, `it.skip('same', () => {}); it('same', () => {});`)],
        issue,
      ),
    ).toEqual([]);
  });

  it('reassigns duplicate matches when execution restrictions overlap', () => {
    expect(
      changeViolations(
        [
          change(
            `it.skipIf(a).runIf(b)('same', () => {});
             it.skipIf(a).only('same', () => {});`,
            `it.skipIf(a)('same', () => {});
             it.runIf(b)('same', () => {});`,
          ),
        ],
        issue,
      ),
    ).toEqual([]);
  });

  it.each([null, `it('existing', () => {});`])(
    'reports invalid test syntax as a violation with baseline %s',
    (before) => {
      expect(
        changeViolations([change(before, `it('broken', () => {`)], issue),
      ).toEqual([
        'test/example.test.ts: cannot inspect test declarations: invalid syntax.',
      ]);
    },
  );

  it.each([
    'test/harness.test.ts',
    'test/harness-run.test.mjs',
    'agent.test.mjs',
    'nested/foo.spec.cjs',
    'src/__tests__/example.ts',
  ])('rejects deleting %s even with an explicit issue reference', (path) => {
    expect(
      changeViolations([change('', null, path)], {
        title: 'Delete tests',
        body: `Delete ${path} for #18`,
      }),
    ).toEqual([expect.stringContaining('deleting an existing test file')]);
  });

  it('detects removals even when additions keep the total case count unchanged', () => {
    expect(
      changeViolations(
        [
          change(
            `it('keep', () => {}); test('remove', () => {});`,
            `it('keep', () => {}); test('new', () => {});`,
          ),
        ],
        issue,
      ),
    ).toEqual([expect.stringContaining('"remove"')]);
  });

  it('detects removing one of two identically named cases', () => {
    expect(
      changeViolations(
        [
          change(
            `it('same', () => {}); it('same', () => {});`,
            `it('same', () => {});`,
          ),
        ],
        issue,
      ),
    ).toHaveLength(1);
  });

  it('accepts formatting, reordering and additional tests', () => {
    expect(
      changeViolations(
        [
          change(
            `it('first', () => {}); test('second', () => {});`,
            `test("second", () => {});\nit("first", () => {});\nit('new', () => {});`,
          ),
        ],
        issue,
      ),
    ).toEqual([]);
  });

  it('allows new test files and unrelated source file deletions', () => {
    expect(
      changeViolations(
        [
          change(null, `it('new', () => {});`),
          change('export const value = 1;', null, 'src/value.ts'),
        ],
        issue,
      ),
    ).toEqual([]);
  });

  it.each([
    'scripts/harness/run.mjs',
    'scripts/harness/new.mjs',
    'docs/HARNESS.md',
  ])('blocks out-of-scope additions, edits and deletions of %s', (path) => {
    for (const [before, after] of [
      [null, 'new'],
      ['old', 'new'],
      ['old', null],
    ])
      expect(changeViolations([change(before, after, path)], issue)).toEqual([
        expect.stringContaining('out-of-scope edit'),
      ]);
  });

  it('requires each protected surface to be explicitly named', () => {
    const changes = [
      change('old', 'new', 'scripts/harness/run.mjs'),
      change('old', 'new', 'docs/HARNESS.md'),
    ];
    expect(
      changeViolations(changes, {
        title: 'Fix scripts/harness/run.mjs',
        body: '',
      }),
    ).toEqual([expect.stringContaining('docs/HARNESS.md')]);
    expect(
      changeViolations(changes, {
        title: 'Fix harness',
        body: 'Update scripts\\harness\\ and docs\\HARNESS.md.',
      }),
    ).toEqual([]);
    expect(
      changeViolations(changes, {
        ...issue,
        comments: [{ body: 'scripts/harness/ docs/HARNESS.md' }],
      }),
    ).toHaveLength(2);
  });
});

describe('base diff collection', () => {
  it('checks committed, staged, unstaged and untracked changes against the pinned base', () => {
    directory = mkdtempSync(join(tmpdir(), 'entra-change-guard-'));
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    const write = (path, text) => writeFileSync(join(directory, path), text);
    git('init', '-q');
    git('config', 'user.name', 'Test Owner');
    git('config', 'user.email', 'owner@example.invalid');
    mkdirSync(join(directory, 'scripts', 'harness'), { recursive: true });
    write('committed.test.mjs', `it('committed', () => {});`);
    write('staged.test.mjs', `it('staged', () => {});`);
    write('unstaged.test.mjs', `it('unstaged', () => {});`);
    write('disabled.test.mjs', `it('disabled', () => {});`);
    write('modified-invalid.test.mjs', `it('existing', () => {});`);
    write('deleted.test.mjs', '');
    write('scripts/harness/run.mjs', '// original');
    git('add', '.');
    git('commit', '-qm', 'Fixture baseline');
    const base = git('rev-parse', 'HEAD');
    write('committed.test.mjs', '');
    git('add', '.');
    git('commit', '-qm', 'Fixture later change');
    write('staged.test.mjs', '');
    git('add', 'staged.test.mjs');
    write('unstaged.test.mjs', '');
    write(
      'disabled.test.mjs',
      `describe.skip('suite', () => { it('disabled', () => {}); });`,
    );
    rmSync(join(directory, 'deleted.test.mjs'));
    write('scripts/harness/run.mjs', '// changed');
    write('scripts/harness/new.mjs', '// new');
    write('invalid.test.mjs', `it('broken', () => {`);
    write('modified-invalid.test.mjs', `it('existing', () => {`);
    vi.spyOn(process, 'cwd').mockImplementation(() => directory);
    const result = checkChanges(base, issue);
    expect(result.ok).toBe(false);
    for (const path of [
      'committed.test.mjs',
      'staged.test.mjs',
      'unstaged.test.mjs',
      'disabled.test.mjs',
      'deleted.test.mjs',
      'scripts/harness/run.mjs',
      'scripts/harness/new.mjs',
    ])
      expect(result.output).toContain(path);
    expect(result.output).toContain('removed test case "committed"');
    expect(result.output).toContain(
      'disabled.test.mjs: disabled or restricted test case "disabled"',
    );
    expect(result.output).toContain('deleting an existing test file');
    for (const path of ['invalid.test.mjs', 'modified-invalid.test.mjs'])
      expect(result.output).toContain(
        `${path}: cannot inspect test declarations: invalid syntax.`,
      );
    expect(
      checkChanges(base, {
        title: 'Fix scripts/harness/',
        body: '',
      }).output,
    ).not.toContain('out-of-scope');
    expect(() => checkChanges('nonexistent-base', issue)).toThrow(/failed/);
  });
});
