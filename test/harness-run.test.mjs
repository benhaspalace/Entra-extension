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

const ok = (stdout = '') => ({ ok: true, stdout, output: stdout });
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let files;
let issueTitle;
let review;
let retro;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv = ['node', 'run.mjs', '17'];
  process.exitCode = 0;
  files = new Map([
    ['implement.md', '{{issue}}'],
    ['review.md', '{{diff}}'],
    ['retro.md', '{{run}}'],
    ['LESSONS.md', '# Lessons\n'],
    ['AGENTS.md', '# Rules\n'],
  ]);
  issueTitle = 'Improve publishing guard';
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
  gh.mockImplementation((args) => {
    if (args[0] === 'issue' && args[1] === 'view')
      return ok(
        JSON.stringify(
          args.includes('labels')
            ? { labels: [] }
            : { number: 17, title: issueTitle, body: '', comments: [] },
        ),
      );
    if (args[0] === 'issue' && args[1] === 'create') return ok('issue-url');
    if (args[0] === 'pr' && args[1] === 'create') return ok('pr-url');
    return ok();
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
      `${issueTitle}\n\nCloses #17.`,
    ]);
    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'create', '--body-file']),
    );
    expect(files.get('pr.md')).toContain('Closes #17');
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
    issueTitle = 'Improve VIOLET-MARKER';
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

  it('neutralizes unexpected failures containing a forbidden term', async () => {
    runAgent.mockImplementation(() => {
      throw new Error('Failure: VIOLET-MARKER');
    });
    await execute();
    expectPolicyStop();
  });
});
