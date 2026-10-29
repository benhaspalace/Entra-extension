import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/review-threads.json';
import { gh } from '../scripts/harness/process.mjs';
import { fetchThreads, replyToThread } from '../scripts/pr/github.mjs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';

vi.mock('../scripts/harness/process.mjs', () => ({ gh: vi.fn() }));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadLocalConfig: vi.fn(),
}));
const repo = { name: 'repo', owner: { login: 'owner' } };
const success = (value) => ({
  ok: true,
  stdout: JSON.stringify(value),
  output: '',
});
beforeEach(() => {
  vi.clearAllMocks();
  loadLocalConfig.mockReturnValue({});
});

describe('GitHub PR operations', () => {
  it('rejects a forbidden reply before posting or resolving', () => {
    loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
    expect(() =>
      replyToThread(
        9,
        repo,
        { threadId: 'thread', commentId: 123 },
        'VIOLET-MARKER',
      ),
    ).toThrow(/Review reply.*violet-marker/);
    expect(gh).not.toHaveBeenCalled();
  });

  it('paginates all review threads and filters resolved threads on every page', () => {
    const first = globalThis.structuredClone(fixture);
    first.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: 'page-two',
    };
    const second = globalThis.structuredClone(fixture);
    second.data.repository.pullRequest.reviewThreads.nodes = [];
    gh.mockReturnValueOnce(success(first)).mockReturnValueOnce(success(second));
    expect(fetchThreads(9, repo).map((thread) => thread.commentId)).toEqual([
      4416706313, 4416706315,
    ]);
    expect(gh).toHaveBeenCalledTimes(2);
    const [args, options] = gh.mock.calls[1];
    expect(args).toEqual(['api', 'graphql', '--input', '-']);
    expect(JSON.parse(options.input).variables).toEqual({
      owner: 'owner',
      name: 'repo',
      pr: 9,
      cursor: 'page-two',
    });
    expect(JSON.parse(options.input).query).toContain('isResolved');
    expect(JSON.parse(options.input).query).toContain('fullDatabaseId');
    expect(JSON.parse(options.input).query).not.toMatch(/\bdatabaseId\b/);
  });

  it('fails on GraphQL errors and repeated pagination cursors', () => {
    gh.mockReturnValue(success({ errors: [{ message: 'denied' }] }));
    expect(() => fetchThreads(9, repo)).toThrow(/denied/);
    const repeated = globalThis.structuredClone(fixture);
    repeated.data.repository.pullRequest.reviewThreads.pageInfo = {
      hasNextPage: true,
      endCursor: 'same',
    };
    gh.mockReturnValue(success(repeated));
    expect(() => fetchThreads(9, repo)).toThrow(/pagination cursor/);
  });

  it.each([true, false])(
    'replies via stdin and resolves only when requested (%s)',
    (resolve) => {
      gh.mockReturnValue(
        success({
          data: {
            resolveReviewThread: { thread: { id: 'thread', isResolved: true } },
          },
        }),
      );
      replyToThread(
        9,
        repo,
        { threadId: 'thread', commentId: 4416706313 },
        'abc123: Fixed "quotes" & $text.',
        resolve,
      );
      expect(gh.mock.calls[0][0]).toEqual([
        'api',
        'repos/owner/repo/pulls/9/comments/4416706313/replies',
        '--method',
        'POST',
        '--input',
        '-',
      ]);
      expect(JSON.parse(gh.mock.calls[0][1].input).body).toBe(
        'abc123: Fixed "quotes" & $text.',
      );
      expect(gh).toHaveBeenCalledTimes(resolve ? 2 : 1);
      if (resolve) {
        const payload = JSON.parse(gh.mock.calls[1][1].input);
        expect(payload.query).toContain('resolveReviewThread');
        expect(payload.variables).toEqual({ id: 'thread' });
      }
    },
  );

  it('does not resolve if posting a reply fails', () => {
    gh.mockImplementation(() => {
      throw new Error('reply rejected');
    });
    expect(() =>
      replyToThread(9, repo, { threadId: 'thread', commentId: 123 }, 'reply'),
    ).toThrow(/rejected/);
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when GitHub does not confirm thread resolution', () => {
    gh.mockReturnValue(success({ data: { resolveReviewThread: null } }));
    expect(() =>
      replyToThread(9, repo, { threadId: 'thread', commentId: 123 }, 'reply'),
    ).toThrow(/did not resolve/);
  });
});
