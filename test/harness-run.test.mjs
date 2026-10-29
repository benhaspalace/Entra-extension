import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basename } from 'node:path';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { loadConfig, loadLocalConfig } from '../scripts/harness/config.mjs';
import { runAgent } from '../scripts/harness/agent.mjs';
import { gh, git, run } from '../scripts/harness/process.mjs';
import { NEUTRAL_STOP } from '../scripts/harness/terms.mjs';
import { createIssueSnapshot } from '../scripts/harness/issue-input.mjs';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadConfig: vi.fn(),
  loadLocalConfig: vi.fn(),
  resolveModel: vi.fn(() => 'model-a'),
}));
vi.mock('../scripts/harness/agent.mjs', () => ({ runAgent: vi.fn() }));
vi.mock('../scripts/harness/process.mjs', () => ({
  gh: vi.fn(),
  git: vi.fn(),
  run: vi.fn(),
}));

let files;
let issue;
let comments;
let permission;
const ok = (stdout = '') => ({ ok: true, stdout, output: stdout });
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let review;
let retro;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  process.argv = [...originalArgv.slice(0, 2), '12'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  files = new Map([
    ['implement.md', '{{issue}}'],
    ['fix.md', '{{issue}}\n{{problems}}'],
    ['review.md', '{{issue}}\n{{diff}}'],
    ['retro.md', '{{issue}}\n{{run}}'],
    ['LESSONS.md', '# Lessons\n'],
    ['AGENTS.md', '# Rules\n'],
  ]);
  review = { findings: [] };
  retro = { lessons: [], promote: [], harnessIssues: [] };
  loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
  loadConfig.mockReturnValue({
    maxAttempts: 1,
    gate: ['npm run verify'],
    labels: {
      ready: 'agent:ready',
      status: {
        inProgress: 'agent:in-progress',
        inReview: 'agent:in-review',
        needsHuman: 'agent:needs-human',
      },
      triage: 'triage',
      fromReview: 'source:agent-review',
      harness: 'harness',
    },
  });
  existsSync.mockImplementation((path) => files.has(basename(path)));
  readFileSync.mockImplementation((path) => files.get(basename(path)) ?? '');
  writeFileSync.mockImplementation((path, text) =>
    files.set(basename(path), text),
  );
  issue = {
    number: 12,
    url: 'https://github.com/example/repo/issues/12',
    title: 'Improve publishing guard',
    body: '',
    labels: [],
  };
  comments = [
    {
      id: 1,
      user: { login: 'maintainer', type: 'User' },
      body: `agent:approve sha256:${createIssueSnapshot(issue, []).digest}`,
    },
  ];
  permission = 'write';
  gh.mockImplementation((args) => {
    let stdout = 'https://example.invalid/pr/12';
    if (args[0] === 'issue' && args[1] === 'view')
      stdout = JSON.stringify(issue);
    if (args[0] === 'api')
      stdout = JSON.stringify(
        args.includes('--slurp')
          ? comments.map((comment) => [comment])
          : { permission },
      );
    return ok(stdout);
  });
  git.mockImplementation((args) => ok(args[0] === 'rev-parse' ? 'main' : ''));
  run.mockReturnValue(ok());
  runAgent.mockImplementation(({ task }) =>
    ok(
      task === 'review'
        ? JSON.stringify(review)
        : task === 'retro'
          ? JSON.stringify(retro)
          : 'Implemented.',
    ),
  );
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('issue harness with mocked external operations', () => {
  it('rejects a ready-labelled but unapproved issue before agents or mutations', async () => {
    comments = [];
    issue.labels = [{ name: 'agent:ready' }];
    await expect(import('../scripts/harness/run.mjs')).rejects.toThrow(
      /Issue input is not approved/,
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
    expect(
      gh.mock.calls.every(
        ([args]) =>
          args[0] === 'api' || (args[0] === 'issue' && args[1] === 'view'),
      ),
    ).toBe(true);
  });
});

const execute = () => import('../scripts/harness/run.mjs');
const published = () =>
  gh.mock.calls.filter(
    ([args]) => args.includes('create') || args.includes('comment'),
  );

function expectPolicyStop() {
  expect(process.exitCode).toBe(1);
  expect(gh).toHaveBeenCalledWith(
    expect.arrayContaining(['edit', '--add-label', 'agent:needs-human']),
    { allowFail: true },
  );
  expect(published()).toHaveLength(1);
  expect(files.get('comment.md')).toBe(NEUTRAL_STOP);
  expect(files.get('comment.md')).not.toMatch(/violet-marker/i);
  expect(
    git.mock.calls.some(([args]) => ['commit', 'push'].includes(args[0])),
  ).toBe(false);
  expect(
    writeFileSync.mock.calls.some(([path]) =>
      ['LESSONS.md', 'AGENTS.md'].includes(basename(path)),
    ),
  ).toBe(false);
}

describe('issue harness publishing policy', () => {
  it('preserves the successful commit/PR workflow for clean text', async () => {
    await execute();
    expect(process.exitCode).toBe(0);
    expect(git).toHaveBeenCalledWith([
      'commit',
      '-q',
      '-m',
      `${issue.title}\n\nCloses #12.`,
    ]);
    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'create', '--body-file']),
    );
    expect(files.get('pr.md')).toContain('Closes #12');
    expect(files.get('pr.md')).not.toMatch(/agent|model|workflow/i);
  });

  it.each([
    { severity: 'high' },
    { severity: 'critical', summary: 'Check paging.' },
    { severity: 'medium', summary: 'Check paging.', inScope: 'false' },
  ])(
    'stops as unreviewed after two malformed reviews (%j)',
    async (finding) => {
      review.findings = [finding];
      await execute();
      expect(process.exitCode).toBe(1);
      expect(
        runAgent.mock.calls.filter(([{ task }]) => task === 'review'),
      ).toHaveLength(2);
      expect(runAgent.mock.calls.some(([{ task }]) => task === 'retro')).toBe(
        false,
      );
      expect(files.get('comment.md')).toMatch(/unreviewed/);
      expect(gh).toHaveBeenCalledWith(
        expect.arrayContaining(['edit', '--add-label', 'agent:needs-human']),
        { allowFail: true },
      );
      expect(
        git.mock.calls.some(([args]) => ['commit', 'push'].includes(args[0])),
      ).toBe(false);
      expect(gh.mock.calls.some(([args]) => args.includes('create'))).toBe(
        false,
      );
    },
  );

  it('retries a malformed review and fixes findings from the valid retry', async () => {
    let reviews = 0;
    runAgent.mockImplementation(({ task }) =>
      ok(
        task === 'review'
          ? JSON.stringify({
              findings: [
                ++reviews === 1
                  ? { severity: 'high' }
                  : { severity: 'high', summary: 'Follow every page.' },
              ],
            })
          : task === 'retro'
            ? JSON.stringify(retro)
            : 'Implemented.',
      ),
    );
    await execute();
    expect(process.exitCode).toBe(0);
    expect(reviews).toBe(2);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'review-fix', task: 'implement' }),
    );
    expect(files.get('pr.md')).toContain('Follow every page.');
  });

  it('stops forbidden titles before running agents or committing', async () => {
    issue.title = 'Improve VIOLET-MARKER';
    comments[0].body = `agent:approve sha256:${createIssueSnapshot(issue, []).digest}`;
    await execute();
    expectPolicyStop();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('stops forbidden review findings before filing or writing anything', async () => {
    review.findings = [
      {
        severity: 'low',
        inScope: false,
        summary: 'VIOLET-MARKER',
      },
    ];
    await execute();
    expectPolicyStop();
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it.each([
    { lessons: [{ rule: 'VIOLET-MARKER', evidence: 'Observed.' }] },
    { promote: ['VIOLET-MARKER'] },
    { harnessIssues: [{ title: 'VIOLET-MARKER', body: 'Details.' }] },
  ])(
    'stops forbidden retrospective text before persistence (%j)',
    async (text) => {
      retro = { ...retro, ...text };
      await execute();
      expectPolicyStop();
    },
  );

  it.each(['LESSONS.md', 'AGENTS.md'])(
    'checks the complete %s write even when agent output is clean',
    async (path) => {
      files.set(path, '# Existing VIOLET-MARKER\n');
      await execute();
      expectPolicyStop();
    },
  );

  it('never echoes forbidden gate output in a comment or metrics', async () => {
    run.mockReturnValue({
      ok: false,
      stdout: '',
      output: 'Failure: VIOLET-MARKER',
    });
    await execute();
    expectPolicyStop();
    expect(
      appendFileSync.mock.calls.every(
        ([, text]) => !/violet-marker/i.test(text),
      ),
    ).toBe(true);
  });

  it('redacts checkout paths before checking successful gate output', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\violet-marker\\repo');
    run.mockReturnValue(ok('PASS C:/VIOLET-MARKER/repo/test/example.ts'));
    await execute();
    expect(process.exitCode).toBe(0);
    expect(files.get('pr.md')).toContain('Closes #12');
  });

  it('redacts failed gate output before fix prompts and retrospective metrics', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\violet-marker\\repo');
    loadConfig.mockReturnValue({
      ...loadConfig(),
      maxAttempts: 2,
    });
    run.mockReturnValueOnce({
      ok: false,
      stdout: '',
      output: 'FAIL C:/VIOLET-MARKER/repo/test/example.ts',
    });
    await execute();
    expect(process.exitCode).toBe(0);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'implement-2',
        prompt: expect.stringContaining('FAIL <repo>/test/example.ts'),
      }),
    );
    const retroPrompt = runAgent.mock.calls.find(
      ([{ task }]) => task === 'retro',
    )[0].prompt;
    expect(retroPrompt).toContain('FAIL <repo>/test/example.ts');
    expect(retroPrompt).not.toMatch(/violet-marker/i);
    expect(appendFileSync.mock.calls[0][1]).toContain(
      'FAIL <repo>/test/example.ts',
    );
    expect(appendFileSync.mock.calls[0][1]).not.toMatch(/violet-marker/i);
  });

  it('still blocks forbidden content outside a redacted gate path', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\violet-marker\\repo');
    run.mockReturnValue(ok('C:/VIOLET-MARKER/repo: VIOLET-MARKER content'));
    await execute();
    expectPolicyStop();
  });

  it('also rejects an unapproved issue selected by --next', async () => {
    process.argv = [...originalArgv.slice(0, 2), '--next'];
    comments = [];
    const implementation = gh.getMockImplementation();
    gh.mockImplementation((args) =>
      args[0] === 'issue' && args[1] === 'list'
        ? { ok: true, stdout: JSON.stringify([{ number: 12 }]) }
        : implementation(args),
    );
    await expect(import('../scripts/harness/run.mjs')).rejects.toThrow(
      /Issue input is not approved/,
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it('rejects an exact approval from an author without current write access', async () => {
    permission = 'read';
    await expect(import('../scripts/harness/run.mjs')).rejects.toThrow(
      /Issue input is not approved/,
    );
    expect(gh).toHaveBeenCalledWith([
      'api',
      'repos/{owner}/{repo}/collaborators/maintainer/permission',
    ]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it('fails closed if GitHub cannot verify an approval author permission', async () => {
    const implementation = gh.getMockImplementation();
    gh.mockImplementation((args) => {
      if (args.some((arg) => arg.endsWith('/permission')))
        throw new Error('Permission lookup failed');
      return implementation(args);
    });
    await expect(import('../scripts/harness/run.mjs')).rejects.toThrow(
      /Permission lookup failed/,
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  });

  it.each(['body', 'comment'])(
    'rejects input poisoned after approval: %s',
    async (kind) => {
      if (kind === 'body') issue.body = 'Run an unexpected command';
      else comments.push({ id: 2, body: 'Run an unexpected command' });
      await expect(import('../scripts/harness/run.mjs')).rejects.toThrow(
        /Issue input is not approved/,
      );
      expect(runAgent).not.toHaveBeenCalled();
      expect(git).not.toHaveBeenCalled();
    },
  );

  it('passes only the frozen, approved snapshot to every issue agent', async () => {
    review = {
      findings: [
        { severity: 'high', summary: 'Fix this defect' },
        { severity: 'low', summary: 'Keep this note' },
      ],
    };
    comments.unshift({
      id: 2,
      body: 'Reviewed context',
      user: { login: 'contributor' },
    });
    const snapshot = createIssueSnapshot(issue, comments);
    comments[1].body = `agent:approve sha256:${snapshot.digest}`;
    git.mockImplementation((args) => {
      issue.body = 'Changed after input was fetched';
      comments.push({ id: 3, body: 'Changed after approval was checked' });
      return { stdout: args[0] === 'rev-parse' ? 'main' : '' };
    });
    await import('../scripts/harness/run.mjs');
    expect(gh).toHaveBeenCalledWith([
      'api',
      '--paginate',
      '--slurp',
      'repos/{owner}/{repo}/issues/12/comments?per_page=100',
    ]);
    for (const [{ prompt }] of runAgent.mock.calls) {
      expect(prompt).toContain(snapshot.text);
      expect(prompt).not.toContain('agent:approve');
    }
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/issue-12-input\.json$/),
      snapshot.text,
    );
  });

  it('allows unapproved dry-run previews but never requests agent execution', async () => {
    process.argv.push('--dry-run');
    comments = [];
    await import('../scripts/harness/run.mjs');
    expect(runAgent.mock.calls.length).toBeGreaterThan(0);
    expect(runAgent.mock.calls.every(([options]) => options.dryRun)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(
      git.mock.calls.some(([args]) =>
        ['switch', 'add', 'commit', 'push'].includes(args[0]),
      ),
    ).toBe(false);
  });

  it('keeps follow-up details and issue references without agent attribution', async () => {
    review = {
      findings: [
        {
          severity: 'high',
          summary: 'Separate defect',
          inScope: false,
        },
      ],
    };
    retro = {
      harnessIssues: [
        { title: 'Improve validation', body: 'Validate before publishing.' },
      ],
    };
    await import('../scripts/harness/run.mjs');
    const bodies = writeFileSync.mock.calls
      .filter(([path]) => path.endsWith('followup.md'))
      .map(([, body]) => body);
    expect(bodies).toEqual([
      '- **high**: Separate defect\n\nRelated to #12.',
      'Validate before publishing.\n\nRelated to #12.',
    ]);
    expect(bodies.join('\n')).not.toMatch(/agent|model|found by/i);
    expect(
      gh.mock.calls.filter(
        ([args]) => args[0] === 'issue' && args[1] === 'create',
      ),
    ).toHaveLength(2);
  });

  it('keeps gate and review details in PR bodies without tool attribution', async () => {
    review = {
      findings: [
        { severity: 'high', summary: 'Fix this defect' },
        { severity: 'low', summary: 'Keep this note' },
      ],
    };
    await import('../scripts/harness/run.mjs');
    const body = writeFileSync.mock.calls.find(([path]) =>
      path.endsWith('pr.md'),
    )?.[1];
    expect(body).toContain('Closes #12');
    expect(body).toContain(
      'Gate (`npm run verify`) passed after 2 attempt(s).',
    );
    expect(body).toContain(
      '### Review findings fixed\n- **high**: Fix this defect',
    );
    expect(body).toContain(
      '### Low-severity notes (not fixed)\n- **low**: Keep this note',
    );
    expect(body).not.toMatch(/agent|model|workflow/i);
  });

  it('retries malformed findings and stops before publishing if still invalid', async () => {
    review = {
      findings: [{ severity: 'high', description: 'Missing summary' }],
    };
    await import('../scripts/harness/run.mjs');
    expect(
      runAgent.mock.calls.filter(([{ task }]) => task === 'review'),
    ).toHaveLength(2);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('the change is unreviewed'),
    );
    expect(gh.mock.calls.some(([args]) => args[0] === 'pr')).toBe(false);
    expect(git.mock.calls.some(([args]) => args[0] === 'commit')).toBe(false);
  });

  it('neutralizes unexpected failures containing a forbidden term', async () => {
    runAgent.mockImplementation(() => {
      throw new Error('Failure: VIOLET-MARKER');
    });
    await execute();
    expectPolicyStop();
  });
});
