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
const cases = (text) => testCases('example.test.ts', text);
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
});

describe('change policy', () => {
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
      'deleted.test.mjs',
      'scripts/harness/run.mjs',
      'scripts/harness/new.mjs',
    ])
      expect(result.output).toContain(path);
    expect(result.output).toContain('removed test case "committed"');
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
