import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gh, git, run } from '../scripts/harness/process.mjs';
import { runAgent } from '../scripts/harness/agent.mjs';
import {
  fetchThreads,
  replyToThread,
  repository,
  hasReviewApproval,
  partitionReviewThreads,
  permissionLookup,
} from '../scripts/pr/github.mjs';
import { address } from '../scripts/pr/address.mjs';
import { sync } from '../scripts/pr/sync.mjs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';
import { createReviewSnapshot } from '../scripts/pr/lib.mjs';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadLocalConfig: vi.fn(),
}));
vi.mock('../scripts/harness/process.mjs', () => ({
  gh: vi.fn(),
  git: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../scripts/harness/agent.mjs', () => ({ runAgent: vi.fn() }));
vi.mock('../scripts/pr/github.mjs', () => ({
  fetchThreads: vi.fn(),
  replyToThread: vi.fn(),
  repository: vi.fn(),
  hasReviewApproval: vi.fn(),
  partitionReviewThreads: vi.fn(),
  permissionLookup: vi.fn(),
}));

const ok = (stdout = '') => ({ ok: true, stdout, output: stdout });
const failed = { ok: false, stdout: '', output: 'failed verification' };
const threads = [
  { threadId: 't1', commentId: 123, body: 'Fix this.' },
  { threadId: 't2', commentId: 125, body: 'Check this.' },
];
const decisions = {
  comments: [
    { commentId: 123, action: 'fixed', reply: 'Fixed the bug.' },
    {
      commentId: 125,
      action: 'declined',
      reply: 'The guard already handles this.',
    },
  ],
};
const reply = (value) =>
  ok(`Done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
let mergePending;
let mergeConflict;
let dirty;
let changed;
let currentHead;
let currentBranch;
let hasConflicts;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PR_GATE_IMAGE', `sha256:${'a'.repeat(64)}`);
  vi.stubEnv('REVIEW_BOT_LOGIN', 'review-bot');
  loadLocalConfig.mockReturnValue({ reviewBotLogin: 'review-bot' });
  mergePending = false;
  mergeConflict = false;
  dirty = false;
  changed = true;
  currentHead = 'original-sha';
  currentBranch = 'feature';
  hasConflicts = false;
  repository.mockReturnValue({ name: 'repo', owner: { login: 'owner' } });
  fetchThreads.mockReturnValue(threads);
  partitionReviewThreads.mockReturnValue({ trusted: [], untrusted: threads });
  permissionLookup.mockReturnValue(vi.fn());
  hasReviewApproval.mockReturnValue(true);
  gh.mockImplementation((args) => {
    if (args[0] === 'pr' && args[1] === 'view')
      return ok(
        JSON.stringify({
          headRefName: 'feature',
          headRefOid: 'original-sha',
          isCrossRepository: false,
        }),
      );
    return ok();
  });
  run.mockReturnValue(ok());
  runAgent.mockReturnValue(reply(decisions));
  git.mockImplementation((args) => {
    const command = args.join(' ');
    if (command === 'status --porcelain') return ok(dirty ? ' M file' : '');
    if (command === 'rev-parse HEAD') return ok(currentHead);
    if (command === 'symbolic-ref --short HEAD') return ok(currentBranch);
    if (command === 'rev-parse refs/remotes/origin/feature')
      return ok('original-sha');
    if (args[0] === 'merge' && args[1] !== '--abort') {
      mergePending = true;
      hasConflicts = mergeConflict;
      return mergeConflict ? failed : ok();
    }
    if (command === 'merge --abort') {
      mergePending = false;
      return ok();
    }
    if (command === 'rev-parse -q --verify MERGE_HEAD')
      return mergePending ? ok('merge-sha') : failed;
    if (args[0] === 'diff' && args.includes('--diff-filter=U'))
      return ok(
        hasConflicts ? `src\\file.ts${args.includes('-z') ? '\0' : '\n'}` : '',
      );
    if (command === 'diff --cached --name-only -z')
      return ok(changed ? 'src\\file.ts\0' : '');
    if (args[0] === 'add' && args[1] === '-A') hasConflicts = false;
    if (args[0] === 'commit') {
      currentHead = 'published-sha';
      mergePending = false;
    }
    return ok();
  });
});

const gitCommands = () => git.mock.calls.map(([args]) => args.join(' '));
const hasPush = () => git.mock.calls.some(([args]) => args[0] === 'push');

describe('address review workflow', () => {
  it('rejects all forbidden replies before committing, pushing or replying', () => {
    loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
    runAgent.mockReturnValue(
      reply({
        comments: [
          decisions.comments[0],
          { ...decisions.comments[1], reply: 'VIOLET-MARKER' },
        ],
      }),
    );
    expect(() => address(9)).toThrow(/Review reply.*violet-marker/);
    expect(gitCommands().some((command) => command.startsWith('commit'))).toBe(
      false,
    );
    expect(hasPush()).toBe(false);
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('checks out the head, gates, commits and pushes before replying, resolving fixed only', () => {
    address(9);
    expect(gh).toHaveBeenCalledWith(['pr', 'checkout', '9']);
    expect(runAgent.mock.calls[0][0]).toMatchObject({
      task: 'addressComments',
      readOnly: false,
    });
    expect(runAgent.mock.calls[0][0].prompt).toContain('"commentId": 123');
    expect(run).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--network=none', '--read-only']),
      { allowFail: true },
    );
    expect(gitCommands()).toContain('push origin HEAD:refs/heads/feature');
    expect(replyToThread).toHaveBeenNthCalledWith(
      1,
      9,
      expect.any(Object),
      threads[0],
      'published-sha: Fixed the bug.',
      true,
    );
    expect(replyToThread).toHaveBeenNthCalledWith(
      2,
      9,
      expect.any(Object),
      threads[1],
      'published-sha: The guard already handles this.',
      false,
    );
    const pushIndex = git.mock.calls.findIndex(([args]) => args[0] === 'push');
    expect(git.mock.invocationCallOrder[pushIndex]).toBeLessThan(
      replyToThread.mock.invocationCallOrder[0],
    );
  });

  it('retries malformed final results once, including missing decisions', () => {
    runAgent
      .mockReturnValueOnce(reply({ comments: [] }))
      .mockReturnValueOnce(reply(decisions));
    address(9);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1][0].prompt).toContain(
      'previous output was invalid',
    );
    expect(hasPush()).toBe(true);
  });

  it('fails after two invalid responses without gating or publishing', () => {
    runAgent.mockReturnValue(ok('no structured result'));
    expect(() => address(9)).toThrow(/invalid results twice/);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('allows exactly two gate-fix retries, and never publishes on persistent failure', () => {
    run.mockReturnValue(failed);
    expect(() => address(9)).toThrow(/still failing/);
    expect(run).toHaveBeenCalledTimes(3);
    expect(runAgent).toHaveBeenCalledTimes(3);
    expect(
      runAgent.mock.calls
        .slice(1)
        .every(([options]) => options.task === 'addressComments'),
    ).toBe(true);
    expect(hasPush()).toBe(false);
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('redacts gate paths before review-fix prompts', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\violet-marker\\repo');
    loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
    run.mockReturnValueOnce({
      ok: false,
      stdout: 'C:/VIOLET-MARKER/repo/test.ts',
      output: 'FAIL C:/VIOLET-MARKER/repo/test.ts',
    });
    try {
      address(9);
      expect(runAgent.mock.calls[1][0].prompt).toContain('FAIL <repo>/test.ts');
      expect(runAgent.mock.calls[1][0].prompt).not.toMatch(/violet-marker/i);
      expect(hasPush()).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('publishes after a gate fix succeeds', () => {
    run.mockReturnValueOnce(failed).mockReturnValueOnce(ok());
    address(9);
    expect(run).toHaveBeenCalledTimes(2);
    expect(hasPush()).toBe(true);
  });

  it('never replies when push fails', () => {
    const implementation = git.getMockImplementation();
    git.mockImplementation((args, options) => {
      if (args[0] === 'push') throw new Error('push rejected');
      return implementation(args, options);
    });
    expect(() => address(9)).toThrow(/push rejected/);
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('leaves declined-only threads open without creating an empty commit', () => {
    changed = false;
    runAgent.mockReturnValue(
      reply({
        comments: decisions.comments.map((comment) => ({
          ...comment,
          action: 'declined',
        })),
      }),
    );
    address(9);
    expect(gitCommands().some((command) => command.startsWith('commit'))).toBe(
      false,
    );
    expect(hasPush()).toBe(false);
    expect(
      replyToThread.mock.calls.every((args) => args.at(-1) === false),
    ).toBe(true);
    expect(replyToThread.mock.calls[0][3]).toContain('original-sha');
  });

  it('rejects a fixed decision with no changed files', () => {
    changed = false;
    expect(() => address(9)).toThrow(/produced no changes/);
    expect(replyToThread).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
  });

  it('returns immediately if every thread is resolved', () => {
    fetchThreads.mockReturnValue([]);
    address(9);
    expect(runAgent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
  });

  it('dry-run only reads metadata and writes runner preview artifacts', () => {
    address(9, true);
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.agents[\\/]tmp$/),
      { recursive: true },
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/pr-9-input\.json$/),
      expect.any(String),
    );
    expect(JSON.parse(writeFileSync.mock.calls[0][1])).toMatchObject({
      repository: 'owner/repo',
      pr: 9,
      head: { branch: 'feature', sha: 'original-sha' },
      threads,
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, task: 'addressComments' }),
    );
    expect(git).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalledWith(['pr', 'checkout', '9']);
    expect(run).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
    expect(hasReviewApproval).not.toHaveBeenCalled();
  });

  it('excludes unapproved untrusted input before checkout, agents, gates or publication', () => {
    hasReviewApproval.mockReturnValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    address(9);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nothing to do'));
    log.mockRestore();
    expect(hasReviewApproval).toHaveBeenCalledWith(
      9,
      { name: 'repo', owner: { login: 'owner' } },
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(Function),
    );
    expect(gh).not.toHaveBeenCalledWith(['pr', 'checkout', '9']);
    expect(runAgent).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('checks approval once and uses the frozen approved threads for all retries', () => {
    runAgent
      .mockReturnValueOnce(reply({ comments: [] }))
      .mockReturnValueOnce(reply(decisions));
    address(9);
    expect(hasReviewApproval).toHaveBeenCalledTimes(1);
    expect(fetchThreads).toHaveBeenCalledTimes(1);
    const checkoutIndex = gh.mock.calls.findIndex(
      ([args]) => args[0] === 'pr' && args[1] === 'checkout',
    );
    expect(hasReviewApproval.mock.invocationCallOrder[0]).toBeLessThan(
      gh.mock.invocationCallOrder[checkoutIndex],
    );
    for (const [options] of runAgent.mock.calls)
      expect(options.prompt).toContain(JSON.stringify(threads, null, 2));
  });

  it('runs trusted threads without approval or an approval snapshot', () => {
    partitionReviewThreads.mockReturnValue({ trusted: threads, untrusted: [] });
    address(9);
    expect(hasReviewApproval).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(hasPush()).toBe(true);
    expect(runAgent.mock.calls[0][0].prompt).toContain(
      JSON.stringify(threads, null, 2),
    );
  });

  it('includes approved untrusted threads alongside trusted threads in original order', () => {
    partitionReviewThreads.mockReturnValue({
      trusted: [threads[1]],
      untrusted: [threads[0]],
    });
    address(9);
    expect(hasReviewApproval).toHaveBeenCalledTimes(1);
    expect(runAgent.mock.calls[0][0].prompt).toContain(
      JSON.stringify(threads, null, 2),
    );
    expect(replyToThread.mock.calls.map((args) => args[2])).toEqual(threads);
    expect(JSON.parse(writeFileSync.mock.calls[0][1]).threads).toEqual([
      threads[0],
    ]);
  });

  it('scopes the digest to untrusted threads and the PR head, excluding them from an unapproved mixed run', () => {
    partitionReviewThreads.mockReturnValue({
      trusted: [threads[0]],
      untrusted: [threads[1]],
    });
    hasReviewApproval.mockReturnValue(false);
    runAgent.mockReturnValue(reply({ comments: [decisions.comments[0]] }));
    address(9);
    const repo = { name: 'repo', owner: { login: 'owner' } };
    const head = { headRefName: 'feature', headRefOid: 'original-sha' };
    const input = createReviewSnapshot(repo, 9, head, [threads[1]]);
    expect(writeFileSync.mock.calls[0][1]).toBe(input.text);
    expect(hasReviewApproval.mock.calls[0][2]).toBe(input.digest);
    expect(runAgent.mock.calls[0][0].prompt).not.toContain('Check this.');
    expect(replyToThread).toHaveBeenCalledTimes(1);
    expect(replyToThread.mock.calls[0][2]).toBe(threads[0]);
    const changedTrusted = [
      { ...threads[0], body: 'changed trusted text' },
      threads[1],
    ];
    fetchThreads.mockReturnValue(changedTrusted);
    partitionReviewThreads.mockReturnValue({
      trusted: [changedTrusted[0]],
      untrusted: [threads[1]],
    });
    currentHead = 'original-sha';
    address(9);
    expect(hasReviewApproval.mock.calls[1][2]).toBe(input.digest);
    expect(
      createReviewSnapshot(repo, 9, { ...head, headRefOid: 'new-head' }, [
        threads[1],
      ]).digest,
    ).not.toBe(input.digest);
  });

  it('surfaces approval lookup errors before any agent or checkout', () => {
    hasReviewApproval.mockImplementation(() => {
      throw new Error('permission unavailable');
    });
    expect(() => address(9)).toThrow(/permission unavailable/);
    expect(runAgent).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalledWith(['pr', 'checkout', '9']);
  });

  it('uses the environment reviewer login before local configuration', () => {
    vi.stubEnv('REVIEW_BOT_LOGIN', 'environment-reviewer');
    loadLocalConfig.mockReturnValue({ reviewBotLogin: 'local-reviewer' });
    address(9, true);
    expect(partitionReviewThreads.mock.calls[0][1]).toBe(
      'environment-reviewer',
    );
    vi.unstubAllEnvs();
    address(9, true);
    expect(partitionReviewThreads.mock.calls[1][1]).toBe('local-reviewer');
  });

  it.each(['environment', 'local'])(
    'normalizes a REST-style %s bot setting before classification',
    (source) => {
      vi.stubEnv(
        'REVIEW_BOT_LOGIN',
        source === 'environment' ? 'Review-Bot[bot]' : undefined,
      );
      loadLocalConfig.mockReturnValue({ reviewBotLogin: 'Review-Bot[bot]' });
      address(9, true);
      expect(partitionReviewThreads.mock.calls[0][1]).toBe('review-bot');
    },
  );

  it.each([undefined, '', '<review-bot-login>', 'bot;command', 123])(
    'rejects invalid review bot configuration %s before classification or execution',
    (login) => {
      vi.stubEnv('REVIEW_BOT_LOGIN', undefined);
      loadLocalConfig.mockReturnValue({ reviewBotLogin: login });
      expect(() => address(9, true)).toThrow(/REVIEW_BOT_LOGIN/);
      expect(partitionReviewThreads).not.toHaveBeenCalled();
      expect(hasReviewApproval).not.toHaveBeenCalled();
      expect(runAgent).not.toHaveBeenCalled();
      expect(gh).not.toHaveBeenCalledWith(['pr', 'checkout', '9']);
      expect(hasPush()).toBe(false);
    },
  );

  it('rejects an invalid environment override instead of falling back to valid local configuration', () => {
    vi.stubEnv('REVIEW_BOT_LOGIN', '');
    expect(() => address(9, true)).toThrow(/REVIEW_BOT_LOGIN/);
    expect(partitionReviewThreads).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('rejects dirty trees, fork PRs, and agents changing HEAD', () => {
    dirty = true;
    expect(() => address(9)).toThrow(/not clean/);
    expect(gh).not.toHaveBeenCalled();
    dirty = false;
    gh.mockReturnValueOnce(ok('{"isCrossRepository":true}'));
    expect(() => address(9)).toThrow(/Fork PRs/);
    runAgent.mockImplementation(() => {
      currentHead = 'agent-commit';
      return reply(decisions);
    });
    expect(() => address(9)).toThrow(/branch or HEAD/);
    expect(hasPush()).toBe(false);
  });

  it('surfaces runner failures without publishing', () => {
    runAgent.mockReturnValue(failed);
    expect(() => address(9)).toThrow(/agent.*failed/);
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
  });
});

describe('stacked PR synchronization', () => {
  it('gates and commits a clean merge without calling a model', () => {
    sync('feature', 'base');
    expect(gitCommands()).toContain(
      'merge --no-commit --no-ff refs/remotes/origin/base',
    );
    expect(gitCommands()).toContain('commit -m Merge origin/base into feature');
    expect(hasPush()).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('routes conflicted files to implement, gates, then commits and pushes', () => {
    mergeConflict = true;
    sync('feature', 'base');
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'implement',
        prompt: expect.stringContaining('src\\\\file.ts'),
      }),
    );
    expect(gitCommands()).toContain('add -A');
    expect(hasPush()).toBe(true);
    expect(mergePending).toBe(false);
  });

  it('preserves a deletion already staged by the conflict agent', () => {
    mergeConflict = true;
    const implementation = git.getMockImplementation();
    git.mockImplementation((args, options) => {
      if (args[0] === 'add' && args.includes('src\\file.ts'))
        throw new Error('pathspec did not match any files');
      return implementation(args, options);
    });
    runAgent.mockImplementation(() => {
      // git rm has removed the conflicted path from both the index and disk.
      hasConflicts = false;
      return ok();
    });
    sync('feature', 'base');
    expect(gitCommands()).not.toContain('add -- src\\file.ts');
    expect(gitCommands()).not.toContain('merge --abort');
    expect(gitCommands()).toContain('commit -m Merge origin/base into feature');
    expect(hasPush()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never falls back to host verification when the sandbox is unconfigured', () => {
    vi.stubEnv('PR_GATE_IMAGE', '');
    expect(() => sync('feature', 'base')).toThrow(/host execution is disabled/);
    expect(gitCommands()).toContain('merge --abort');
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
  });

  it('aborts on persistent gate failure and never commits or pushes', () => {
    mergeConflict = true;
    run.mockReturnValue(failed);
    expect(() => sync('feature', 'base')).toThrow(/still failing/);
    expect(run).toHaveBeenCalledTimes(3);
    expect(gitCommands()).toContain('merge --abort');
    expect(gitCommands().some((command) => command.startsWith('commit'))).toBe(
      false,
    );
    expect(hasPush()).toBe(false);
    expect(mergePending).toBe(false);
  });

  it('aborts if conflict resolution fails', () => {
    mergeConflict = true;
    runAgent.mockReturnValue(failed);
    expect(() => sync('feature', 'base')).toThrow(/agent.*failed/);
    expect(gitCommands()).toContain('merge --abort');
    expect(hasPush()).toBe(false);
  });

  it('rejects staged conflict markers before committing and aborts', () => {
    const implementation = git.getMockImplementation();
    git.mockImplementation((args, options) => {
      if (args.join(' ') === 'diff --cached --check')
        throw new Error('leftover conflict marker');
      return implementation(args, options);
    });
    expect(() => sync('feature', 'base')).toThrow(/conflict marker/);
    expect(gitCommands()).toContain('merge --abort');
    expect(hasPush()).toBe(false);
  });

  it('checks an up-to-date branch without calling a model or creating a commit', () => {
    const implementation = git.getMockImplementation();
    git.mockImplementation((args, options) => {
      if (args[0] === 'merge') return ok('Already up to date.');
      return implementation(args, options);
    });
    sync('feature', 'base');
    expect(run).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(gitCommands().some((command) => command.startsWith('commit'))).toBe(
      false,
    );
    expect(hasPush()).toBe(true);
  });

  it('rejects option-like refs, matching branches, dirty trees, and stale local heads', () => {
    expect(() => sync('--bad', 'base')).toThrow(/valid branch/);
    expect(() => sync('feature', 'feature')).toThrow(/must differ/);
    dirty = true;
    expect(() => sync('feature', 'base')).toThrow(/not clean/);
    dirty = false;
    currentHead = 'stale';
    expect(() => sync('feature', 'base')).toThrow(/match its remote/);
    expect(hasPush()).toBe(false);
  });
});
