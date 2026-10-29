import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runAgent } from '../scripts/harness/agent.mjs';
import { loadConfig } from '../scripts/harness/config.mjs';
import { gh, git, run } from '../scripts/harness/process.mjs';
import { createIssueSnapshot } from '../scripts/harness/issue-input.mjs';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('../scripts/harness/agent.mjs', () => ({ runAgent: vi.fn() }));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadConfig: vi.fn(),
  resolveModel: vi.fn(() => 'model-a'),
}));
vi.mock('../scripts/harness/process.mjs', () => ({
  gh: vi.fn(),
  git: vi.fn(),
  run: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let review;
let retro;
let issue;
let comments;
let permission;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  process.argv = [...originalArgv.slice(0, 2), '12'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  existsSync.mockImplementation((path) => path.includes('prompts'));
  readFileSync.mockReturnValue('{{issue}}');
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
    },
  });
  git.mockImplementation((args) => ({
    stdout: args[0] === 'rev-parse' ? 'main' : '',
  }));
  issue = {
    number: 12,
    url: 'https://github.com/example/repo/issues/12',
    title: 'Fix defect',
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
    return { ok: true, stdout };
  });
  run.mockReturnValue({ ok: true, output: '' });
  review = {
    findings: [
      { severity: 'high', summary: 'Fix this defect' },
      { severity: 'low', summary: 'Keep this note' },
    ],
  };
  retro = {};
  runAgent.mockImplementation(({ task }) => ({
    ok: true,
    stdout: JSON.stringify(
      task === 'review' ? review : task === 'retro' ? retro : {},
    ),
  }));
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
});
