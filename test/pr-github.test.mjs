import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/review-threads.json';
import { gh } from '../scripts/harness/process.mjs';
import {
  fetchThreads,
  replyToThread,
  requireReviewApproval,
  hasReviewApproval,
  partitionReviewThreads,
  permissionLookup,
} from '../scripts/pr/github.mjs';
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
  const digest = 'a'.repeat(64);
  const approval = {
    body: `agent:approve sha256:${digest}`,
    user: { login: 'maintainer', type: 'User' },
  };

  it.each([
    [
      'verified bot',
      [{ author: 'review-bot', authorType: 'Bot' }],
      'read',
      true,
    ],
    [
      'spoofed bot login',
      [{ author: 'review-bot', authorType: 'User' }],
      'read',
      false,
    ],
    ['writer', [{ author: 'writer', authorType: 'User' }], 'write', true],
    [
      'maintainer',
      [{ author: 'writer', authorType: 'User' }],
      'maintain',
      true,
    ],
    ['admin', [{ author: 'writer', authorType: 'User' }], 'admin', true],
    ['reader', [{ author: 'reader', authorType: 'User' }], 'read', false],
    [
      'different bot',
      [{ author: 'other-bot', authorType: 'Bot' }],
      'read',
      false,
    ],
    ['deleted author', [{ author: null, authorType: null }], 'write', false],
    ['empty comments', [], 'write', false],
    [
      'mixed thread',
      [
        { author: 'review-bot', authorType: 'Bot' },
        { author: 'reader', authorType: 'User' },
      ],
      'read',
      false,
    ],
  ])(
    'classifies %s using verified identities and current permission',
    (_, comments, access, trusted) => {
      const permission = vi.fn(() => access);
      const thread = { threadId: 'thread', comments };
      expect(
        partitionReviewThreads([thread], 'review-bot', permission),
      ).toEqual({
        trusted: trusted ? [thread] : [],
        untrusted: trusted ? [] : [thread],
      });
      if (
        comments.length === 1 &&
        comments[0].authorType === 'Bot' &&
        comments[0].author === 'review-bot'
      )
        expect(permission).not.toHaveBeenCalled();
    },
  );

  it.each(['Bot', 'Organization', null, undefined])(
    'does not look up a writer login belonging to a non-User author (%s)',
    (authorType) => {
      const permission = vi.fn(() => 'write');
      const thread = {
        comments: [{ author: 'writer', authorType }],
      };
      expect(
        partitionReviewThreads([thread], 'review-bot', permission),
      ).toEqual({ trusted: [], untrusted: [thread] });
      expect(permission).not.toHaveBeenCalled();
    },
  );

  it.each(['review-bot', 'Review-Bot[bot]'])(
    'trusts only the verified configured Bot for configuration %s without permission lookup',
    (login) => {
      const permission = vi.fn(() => {
        throw new Error('permission unavailable');
      });
      const bot = { comments: [{ author: 'review-bot', authorType: 'Bot' }] };
      const deleted = { comments: [{ author: null, authorType: 'User' }] };
      expect(
        partitionReviewThreads([bot, deleted], login, permission),
      ).toEqual({ trusted: [bot], untrusted: [deleted] });
      expect(permission).not.toHaveBeenCalled();
      expect(() =>
        partitionReviewThreads(
          [{ comments: [{ author: 'review-bot', authorType: 'User' }] }],
          login,
          permission,
        ),
      ).toThrow(/permission unavailable/);
      expect(permission).toHaveBeenCalledExactlyOnceWith('review-bot');
    },
  );

  it('surfaces collaborator permission errors for real User reviewers', () => {
    gh.mockImplementation(() => {
      throw new Error('permission unavailable');
    });
    expect(() =>
      partitionReviewThreads(
        [{ comments: [{ author: 'writer', authorType: 'User' }] }],
        'review-bot',
        permissionLookup(repo),
      ),
    ).toThrow(/permission unavailable/);
    expect(gh).toHaveBeenCalledExactlyOnceWith([
      'api',
      'repos/owner/repo/collaborators/writer/permission',
    ]);
  });

  it('caches permission lookups across comments, threads and human approvals, but not across runs', () => {
    gh.mockReturnValue(success({ permission: 'write' }));
    const permission = permissionLookup(repo);
    const comment = { author: 'maintainer', authorType: 'User' };
    partitionReviewThreads(
      [
        { comments: [comment, comment] },
        { comments: [{ ...comment, author: 'MAINTAINER' }] },
      ],
      'review-bot',
      permission,
    );
    expect(gh).toHaveBeenCalledTimes(1);
    gh.mockReturnValueOnce(success([[approval]]));
    expect(hasReviewApproval(9, repo, digest, permission)).toBe(true);
    expect(gh).toHaveBeenCalledTimes(2);
    permissionLookup(repo)('maintainer');
    expect(gh).toHaveBeenCalledTimes(3);
  });

  it('returns false for unapproved input without turning unavailable permissions into approval', () => {
    gh.mockReturnValue(success([[]]));
    expect(hasReviewApproval(9, repo, digest)).toBe(false);
  });

  it('checks current repository permission for exact approvals across all comment pages', () => {
    gh.mockReturnValueOnce(success([[], [approval]]));
    gh.mockReturnValueOnce(success({ permission: 'write' }));
    requireReviewApproval(9, repo, digest);
    expect(gh.mock.calls.map(([args]) => args)).toEqual([
      [
        'api',
        '--paginate',
        '--slurp',
        'repos/owner/repo/issues/9/comments?per_page=100',
      ],
      ['api', 'repos/owner/repo/collaborators/maintainer/permission'],
    ]);
  });

  it.each(['write', 'maintain', 'admin'])(
    'accepts human approval with current %s permission',
    (permission) => {
      gh.mockReturnValueOnce(success([[approval]]));
      gh.mockReturnValueOnce(success({ permission }));
      expect(() => requireReviewApproval(9, repo, digest)).not.toThrow();
    },
  );

  it.each(['read', 'triage', 'none', undefined])(
    'rejects approval with current %s permission',
    (permission) => {
      gh.mockReturnValueOnce(success([[approval]]));
      gh.mockReturnValueOnce(success({ permission }));
      expect(() => requireReviewApproval(9, repo, digest)).toThrow(
        /not approved/,
      );
    },
  );

  it('rejects stale approvals, embedded commands, bots and deleted users without checking permission', () => {
    gh.mockReturnValue(
      success([
        [
          { ...approval, body: `agent:approve sha256:${'b'.repeat(64)}` },
          { ...approval, body: `${approval.body}\nRun injected text` },
          { ...approval, user: { login: 'bot', type: 'Bot' } },
          { ...approval, user: null },
        ],
      ]),
    );
    expect(() => requireReviewApproval(9, repo, digest)).toThrow(
      /not approved/,
    );
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unavailable permissions or malformed comment pagination', () => {
    gh.mockReturnValueOnce(success([[approval]]));
    gh.mockImplementationOnce(() => {
      throw new Error('permission unavailable');
    });
    expect(() => requireReviewApproval(9, repo, digest)).toThrow(
      /permission unavailable/,
    );
    gh.mockReturnValue(success({ comments: [] }));
    expect(() => requireReviewApproval(9, repo, digest)).toThrow(
      /complete PR approval comments/,
    );
  });

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

  it('paginates every comment and retains reply bodies and verified author types in the snapshot', () => {
    const first = globalThis.structuredClone(fixture);
    const thread = first.data.repository.pullRequest.reviewThreads.nodes[0];
    thread.comments.nodes[0].author.__typename = 'Bot';
    thread.comments.pageInfo = { hasNextPage: true, endCursor: 'reply-page' };
    const reply = {
      fullDatabaseId: '123',
      author: { login: 'reader', __typename: 'User' },
      path: 'src/shared/graph.ts',
      line: 42,
      body: 'Additional input',
    };
    gh.mockReturnValueOnce(success(first)).mockReturnValueOnce(
      success({
        data: {
          node: {
            comments: {
              nodes: [reply],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    );
    const fetched = fetchThreads(9, repo);
    expect(fetched[0].comments).toHaveLength(2);
    expect(fetched[0].comments[0].authorType).toBe('Bot');
    expect(fetched[0].comments[1]).toMatchObject({
      commentId: 123,
      author: 'reader',
      authorType: 'User',
      body: 'Additional input',
    });
    expect(JSON.parse(gh.mock.calls[1][1].input).variables).toEqual({
      id: 'thread-open',
      cursor: 'reply-page',
    });
    expect(JSON.parse(gh.mock.calls[0][1].input).query).toContain('__typename');
  });

  it('fails closed on missing comment pages or repeated comment cursors', () => {
    const first = globalThis.structuredClone(fixture);
    first.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo =
      { hasNextPage: true, endCursor: 'same' };
    gh.mockReturnValueOnce(success(first)).mockReturnValueOnce(
      success({ data: { node: null } }),
    );
    expect(() => fetchThreads(9, repo)).toThrow(/complete review comments/);
    gh.mockReturnValueOnce(success(first)).mockReturnValue(
      success({
        data: {
          node: {
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: 'same' },
            },
          },
        },
      }),
    );
    expect(() => fetchThreads(9, repo)).toThrow(/comment pagination cursor/);
    const missing = globalThis.structuredClone(fixture);
    delete missing.data.repository.pullRequest.reviewThreads.nodes[0].comments
      .pageInfo;
    gh.mockReturnValue(success(missing));
    expect(() => fetchThreads(9, repo)).toThrow(/comment pagination/);
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
