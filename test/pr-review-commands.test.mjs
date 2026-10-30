import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/review-state.json';
import { gh, run } from '../scripts/harness/process.mjs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';
import {
  repository,
  permissionLookup,
  fetchThreads,
} from '../scripts/pr/github.mjs';
import { requestReview } from '../scripts/pr/request-review.mjs';
import { fetchPages, reviewCheck } from '../scripts/pr/review-check.mjs';

vi.mock('../scripts/harness/process.mjs', () => ({
  gh: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../scripts/harness/config.mjs', () => ({ loadLocalConfig: vi.fn() }));
vi.mock('../scripts/pr/github.mjs', () => ({
  repository: vi.fn(),
  permissionLookup: vi.fn(),
  fetchThreads: vi.fn(),
}));
const config = {
  reviewBotLogin: 'review-bot',
  reviewTriggers: ['request code', 'request security'],
  reviewStateMarker: 'review-state:v1',
};
const repo = { name: 'repo', owner: { login: 'owner' } };
const ok = (value) => ({ stdout: JSON.stringify(value), ok: true });
let comments;
let permission;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('REVIEW_BOT_LOGIN', undefined);
  vi.stubEnv('REVIEW_TRIGGERS', undefined);
  vi.stubEnv('REVIEW_STATE_MARKER', undefined);
  loadLocalConfig.mockReturnValue(config);
  repository.mockReturnValue(repo);
  permission = vi.fn(() => 'write');
  permissionLookup.mockReturnValue(permission);
  fetchThreads.mockReturnValue([]);
  comments = globalThis.structuredClone(fixture.comments);
  gh.mockImplementation((args) => {
    if (args[0] === 'pr')
      return ok({ ...fixture, headRefOid: fixture.headSha });
    if (args.at(-1).includes('/comments?')) return ok([comments]);
    if (args.at(-1).includes('/files?'))
      return ok([[{ filename: 'AGENTS.md' }]]);
    throw new Error(`Unexpected call: ${args}`);
  });
});

describe('review request command', () => {
  it('posts exactly the two trusted triggers with head-bound request metadata using stdin', () => {
    requestReview(9, { expectedHead: fixture.headSha });
    expect(run).toHaveBeenCalledTimes(2);
    for (const [index, [command, args, options]] of run.mock.calls.entries()) {
      expect(command).toBe('gh');
      expect(args).toEqual([
        'api',
        'repos/owner/repo/issues/9/comments',
        '--method',
        'POST',
        '--input',
        '-',
      ]);
      expect(JSON.parse(options.input).body).toContain(
        `${config.reviewTriggers[index]}\n\n<!-- review-state:v1:request`,
      );
      expect(JSON.parse(options.input).body).toContain(fixture.headSha);
    }
  });
  it('waits for stale PR heads after a push before posting either trigger', () => {
    const previousHead = 'b'.repeat(40);
    gh.mockReturnValueOnce(
      ok({ headRefOid: previousHead }),
    ).mockReturnValueOnce(ok({ headRefOid: previousHead }));
    const wait = vi.fn(() => {
      expect(run).not.toHaveBeenCalled();
    });
    requestReview(9, {
      expectedHead: fixture.headSha,
      previousHead,
      wait,
    });
    expect(wait.mock.calls).toEqual([[1000], [2000]]);
    expect(gh).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(2);
    for (const [, , options] of run.mock.calls)
      expect(JSON.parse(options.input).body).toContain(fixture.headSha);
  });
  it('bounds stale-head polling to 30 seconds without posting on timeout', () => {
    const wait = vi.fn();
    expect(() =>
      requestReview(9, {
        expectedHead: 'b'.repeat(40),
        previousHead: fixture.headSha,
        wait,
      }),
    ).toThrow(/within 30 seconds/);
    expect(wait.mock.calls.flat().reduce((sum, delay) => sum + delay, 0)).toBe(
      30000,
    );
    expect(gh).toHaveBeenCalledTimes(6);
    expect(run).not.toHaveBeenCalled();
  });
  it('fails immediately on a concurrent non-stale head, including during polling', () => {
    const wait = vi.fn();
    gh.mockReturnValueOnce(
      ok({ headRefOid: fixture.headSha }),
    ).mockReturnValueOnce(ok({ headRefOid: 'c'.repeat(40) }));
    expect(() =>
      requestReview(9, {
        expectedHead: 'b'.repeat(40),
        previousHead: fixture.headSha,
        wait,
      }),
    ).toThrow(/head changed/);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });
  it('fails before posting on a changed or malformed head and surfaces posting errors', () => {
    const wait = vi.fn();
    expect(() =>
      requestReview(9, {
        expectedHead: 'b'.repeat(40),
        previousHead: 'c'.repeat(40),
        wait,
      }),
    ).toThrow(/head changed/);
    expect(wait).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    gh.mockReturnValueOnce(ok({ headRefOid: 'bad' }));
    expect(() => requestReview(9)).toThrow(/valid PR head/);
    run.mockImplementation(() => {
      throw new Error('post rejected');
    });
    expect(() => requestReview(9)).toThrow(/post rejected/);
  });
});

describe('review check command', () => {
  it('collects all pages and resolved threads; owner requests do not need a permission lookup', () => {
    expect(reviewCheck(9)).toEqual({ exitCode: 0, reasons: [] });
    expect(permission).not.toHaveBeenCalled();
    expect(fetchThreads).toHaveBeenCalledWith(9, repo, false);
    expect(gh).toHaveBeenCalledWith([
      'api',
      '--paginate',
      '--slurp',
      'repos/owner/repo/pulls/9/files?per_page=100',
    ]);
  });
  it('counts current collaborators but not read-only users or Bot requesters', () => {
    for (const comment of comments.slice(0, 2))
      comment.user.login = 'collaborator';
    expect(reviewCheck(9).exitCode).toBe(0);
    expect(permission).toHaveBeenCalledWith('collaborator');
    permission.mockReturnValue('read');
    expect(reviewCheck(9).exitCode).toBe(1);
    for (const comment of comments.slice(0, 2)) comment.user.type = 'Bot';
    permission.mockClear();
    expect(reviewCheck(9).exitCode).toBe(1);
    expect(permission).not.toHaveBeenCalled();
  });
  it('rejects concurrent pushes after collecting the snapshot', () => {
    gh.mockReturnValueOnce(ok({ ...fixture, headRefOid: fixture.headSha }))
      .mockReturnValueOnce(ok([comments]))
      .mockReturnValueOnce(ok([[]]))
      .mockReturnValueOnce(ok({ headRefOid: 'b'.repeat(40) }));
    expect(reviewCheck(9).reasons.join()).toContain('head changed');
  });
  it('does not silently accept malformed pagination', () => {
    gh.mockReturnValue(ok({ comments: [] }));
    expect(() => fetchPages('endpoint')).toThrow(/complete review-check pages/);
  });
});
