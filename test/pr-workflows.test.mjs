import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gh, git, run } from '../scripts/harness/process.mjs';
import { runCopilot } from '../scripts/harness/copilot.mjs';
import {
  fetchThreads,
  replyToThread,
  repository,
} from '../scripts/pr/github.mjs';
import { address } from '../scripts/pr/address.mjs';
import { sync } from '../scripts/pr/sync.mjs';

vi.mock('../scripts/harness/process.mjs', () => ({
  gh: vi.fn(),
  git: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../scripts/harness/copilot.mjs', () => ({ runCopilot: vi.fn() }));
vi.mock('../scripts/pr/github.mjs', () => ({
  fetchThreads: vi.fn(),
  replyToThread: vi.fn(),
  repository: vi.fn(),
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
  mergePending = false;
  mergeConflict = false;
  dirty = false;
  changed = true;
  currentHead = 'original-sha';
  currentBranch = 'feature';
  hasConflicts = false;
  repository.mockReturnValue({ name: 'repo', owner: { login: 'owner' } });
  fetchThreads.mockReturnValue(threads);
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
  runCopilot.mockReturnValue(reply(decisions));
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
    if (args[0] === 'add' && args[1] === '--') hasConflicts = false;
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
  it('checks out the head, gates, commits and pushes before replying, resolving fixed only', () => {
    address(9);
    expect(gh).toHaveBeenCalledWith(['pr', 'checkout', '9']);
    expect(runCopilot.mock.calls[0][0]).toMatchObject({
      task: 'addressComments',
      readOnly: false,
    });
    expect(runCopilot.mock.calls[0][0].prompt).toContain('"commentId": 123');
    expect(run).toHaveBeenCalledWith('npm', ['run', 'verify'], {
      allowFail: true,
      shell: true,
    });
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
    runCopilot
      .mockReturnValueOnce(reply({ comments: [] }))
      .mockReturnValueOnce(reply(decisions));
    address(9);
    expect(runCopilot).toHaveBeenCalledTimes(2);
    expect(runCopilot.mock.calls[1][0].prompt).toContain(
      'previous output was invalid',
    );
    expect(hasPush()).toBe(true);
  });

  it('fails after two invalid responses without gating or publishing', () => {
    runCopilot.mockReturnValue(ok('no structured result'));
    expect(() => address(9)).toThrow(/invalid results twice/);
    expect(runCopilot).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('allows exactly two gate-fix retries, and never publishes on persistent failure', () => {
    run.mockReturnValue(failed);
    expect(() => address(9)).toThrow(/still failing/);
    expect(run).toHaveBeenCalledTimes(3);
    expect(runCopilot).toHaveBeenCalledTimes(3);
    expect(
      runCopilot.mock.calls
        .slice(1)
        .every(([options]) => options.task === 'addressComments'),
    ).toBe(true);
    expect(hasPush()).toBe(false);
    expect(replyToThread).not.toHaveBeenCalled();
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
    runCopilot.mockReturnValue(
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
    expect(runCopilot).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(hasPush()).toBe(false);
  });

  it('dry-run only reads metadata and writes runner preview artifacts', () => {
    address(9, true);
    expect(runCopilot).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, task: 'addressComments' }),
    );
    expect(git).not.toHaveBeenCalled();
    expect(gh).not.toHaveBeenCalledWith(['pr', 'checkout', '9']);
    expect(run).not.toHaveBeenCalled();
    expect(replyToThread).not.toHaveBeenCalled();
  });

  it('rejects dirty trees, fork PRs, and agents changing HEAD', () => {
    dirty = true;
    expect(() => address(9)).toThrow(/not clean/);
    expect(gh).not.toHaveBeenCalled();
    dirty = false;
    gh.mockReturnValueOnce(ok('{"isCrossRepository":true}'));
    expect(() => address(9)).toThrow(/Fork PRs/);
    runCopilot.mockImplementation(() => {
      currentHead = 'agent-commit';
      return reply(decisions);
    });
    expect(() => address(9)).toThrow(/branch or HEAD/);
    expect(hasPush()).toBe(false);
  });

  it('surfaces runner failures without publishing', () => {
    runCopilot.mockReturnValue(failed);
    expect(() => address(9)).toThrow(/Copilot.*failed/);
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
    expect(runCopilot).not.toHaveBeenCalled();
  });

  it('routes conflicted files to implement, gates, then commits and pushes', () => {
    mergeConflict = true;
    sync('feature', 'base');
    expect(runCopilot).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'implement',
        prompt: expect.stringContaining('src\\\\file.ts'),
      }),
    );
    expect(gitCommands()).toContain('add -- src\\file.ts');
    expect(hasPush()).toBe(true);
    expect(mergePending).toBe(false);
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
    runCopilot.mockReturnValue(failed);
    expect(() => sync('feature', 'base')).toThrow(/Copilot.*failed/);
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
    expect(runCopilot).not.toHaveBeenCalled();
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
