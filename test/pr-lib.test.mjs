import { describe, expect, it } from 'vitest';
import fixture from './fixtures/review-threads.json';
import {
  createReviewSnapshot,
  formatReply,
  isAddressResult,
  parseAddressResult,
  parsePrArgs,
  shapeThreads,
} from '../scripts/pr/lib.mjs';
import { resolveModel } from '../scripts/harness/config.mjs';

const config = {
  tasks: ['implement', 'review', 'retro', 'addressComments', 'triage'],
  models: {
    implement: 'model-a',
    review: 'model-b',
    retro: 'model-b',
    addressComments: 'model-a',
    triage: 'model-c',
  },
};

describe('agent model routing', () => {
  it.each([
    ['implement', 'model-a'],
    ['review', 'model-b'],
    ['retro', 'model-b'],
    ['addressComments', 'model-a'],
    ['triage', 'model-c'],
  ])('routes %s to %s', (task, model) => {
    expect(resolveModel(task, config)).toBe(model);
  });

  it('rejects unknown tasks, inherited properties, and unsafe model IDs', () => {
    for (const task of ['missing', 'toString', '__proto__'])
      expect(() => resolveModel(task, config)).toThrow(/Unknown agent task/);
    for (const model of ['', null, 123, 'model & echo bad'])
      expect(() =>
        resolveModel('implement', { ...config, models: { implement: model } }),
      ).toThrow(/Invalid/);
    expect(() => resolveModel('implement', {})).toThrow();
  });
});

describe('PR pure helpers', () => {
  it('binds review approval to the repository, PR, head and exact thread snapshot', () => {
    const repo = { name: 'repo', owner: { login: 'owner' } };
    const head = { headRefName: 'feature', headRefOid: 'abc123' };
    const threads = shapeThreads(fixture);
    const input = createReviewSnapshot(repo, 9, head, threads);
    expect(input.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(input.text)).toEqual({
      version: 1,
      repository: 'owner/repo',
      pr: 9,
      head: { branch: 'feature', sha: 'abc123' },
      threads,
    });
    expect(createReviewSnapshot(repo, 9, head, threads)).toEqual(input);
    for (const changed of [
      [],
      threads.slice(1),
      [...threads, { ...threads[0], commentId: 999 }],
      ...['threadId', 'commentId', 'author', 'path', 'line', 'body'].map(
        (field) => [{ ...threads[0], [field]: 'changed' }, threads[1]],
      ),
    ])
      expect(createReviewSnapshot(repo, 9, head, changed).digest).not.toBe(
        input.digest,
      );
    for (const [otherRepo, pr, otherHead] of [
      [{ ...repo, name: 'other' }, 9, head],
      [{ ...repo, owner: { login: 'other' } }, 9, head],
      [repo, 10, head],
      [repo, 9, { ...head, headRefName: 'other' }],
      [repo, 9, { ...head, headRefOid: 'new-head' }],
    ])
      expect(
        createReviewSnapshot(otherRepo, pr, otherHead, threads).digest,
      ).not.toBe(input.digest);
  });

  it('shapes unresolved GraphQL review threads and preserves unavailable metadata', () => {
    expect(shapeThreads(fixture)).toEqual([
      {
        threadId: 'thread-open',
        commentId: 4416706313,
        author: 'reviewer',
        path: 'src/shared/graph.ts',
        line: 42,
        body: 'Please follow the next page.',
      },
      {
        threadId: 'thread-outdated',
        commentId: 4416706315,
        author: null,
        path: 'src/shared/graph.ts',
        line: null,
        body: 'Outdated comment.',
      },
    ]);
    expect(shapeThreads(fixture, false)).toHaveLength(3);
    const empty = globalThis.structuredClone(fixture);
    empty.data.repository.pullRequest.reviewThreads.nodes = [];
    expect(shapeThreads(empty)).toEqual([]);
  });

  it('fails explicitly on GraphQL errors, missing PRs, or missing comments', () => {
    expect(() => shapeThreads({ errors: [{ message: 'denied' }] })).toThrow(
      /GraphQL/,
    );
    expect(() => shapeThreads({ data: { repository: null } })).toThrow(
      /review threads/,
    );
    const broken = globalThis.structuredClone(fixture);
    broken.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes =
      [];
    expect(() => shapeThreads(broken)).toThrow(/root comment/);
  });

  it.each(['4416706313', 4416706313, String(Number.MAX_SAFE_INTEGER)])(
    'normalizes full database ID %s to a safe numeric comment ID',
    (id) => {
      const response = globalThis.structuredClone(fixture);
      response.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].fullDatabaseId =
        id;
      expect(shapeThreads(response)[0].commentId).toBe(Number(id));
    },
  );

  it.each([
    null,
    undefined,
    '',
    ' ',
    '4.4e9',
    '4416706313.0',
    'invalid',
    0,
    -1,
    1.5,
    '9007199254740993',
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid or unsafe full database ID %s', (id) => {
    const response = globalThis.structuredClone(fixture);
    response.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].fullDatabaseId =
      id;
    expect(() => shapeThreads(response)).toThrow(/root comment/);
  });

  const valid = {
    comments: [
      { commentId: 123, action: 'fixed', reply: 'Added pagination.' },
      {
        commentId: 125,
        action: 'declined',
        reply: 'Already covered by the guard.',
      },
    ],
  };

  it('requires exactly one well-formed decision for each supplied comment ID', () => {
    expect(isAddressResult(valid, [123, 125])).toBe(true);
    expect(isAddressResult({ comments: [] }, [])).toBe(true);
    expect(
      isAddressResult(
        {
          comments: [
            { commentId: 4416706313, action: 'fixed', reply: 'Fixed.' },
          ],
        },
        [4416706313],
      ),
    ).toBe(true);
    for (const value of [
      null,
      {},
      { comments: 'none' },
      { comments: [null] },
      { comments: [valid.comments[0], valid.comments[0]] },
      { comments: [valid.comments[0]] },
      {
        comments: [
          ...valid.comments,
          { commentId: 999, action: 'fixed', reply: 'x' },
        ],
      },
    ])
      expect(isAddressResult(value, [123, 125])).toBe(false);
    for (const overrides of [
      { commentId: '123' },
      { commentId: -1 },
      { commentId: 1.5 },
      { commentId: Number.MAX_SAFE_INTEGER + 1 },
      { action: 'ignored' },
      { reply: '' },
      { reply: '  ' },
      { reply: 'two\nlines' },
      { reply: 'two\rlines' },
      { reply: 123 },
    ])
      expect(
        isAddressResult({ comments: [{ ...valid.comments[0], ...overrides }] }),
      ).toBe(false);
  });

  it('accepts only valid final fenced JSON, not prose, bare JSON, or earlier drafts', () => {
    const block = `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    expect(parseAddressResult(`Done.\n${block}\n`, [123, 125])).toEqual(valid);
    expect(
      parseAddressResult(
        `${block}\n\`\`\`json\n{"comments":[]}\n\`\`\``,
        [123, 125],
      ),
    ).toBeNull();
    expect(
      parseAddressResult(`${block}\n\`\`\`json\nbroken\n\`\`\``, [123, 125]),
    ).toBeNull();
    expect(parseAddressResult(`${block}\nMore prose`, [123, 125])).toBeNull();
    expect(
      parseAddressResult(
        `${block}\n\`\`\`text\nnot a result\n\`\`\``,
        [123, 125],
      ),
    ).toBeNull();
    expect(parseAddressResult(JSON.stringify(valid), [123, 125])).toBeNull();
  });

  it('trims replies without adding attribution or interpreting the message', () => {
    expect(formatReply('  abc123: Fixed it. \n')).toBe('abc123: Fixed it.');
    expect(formatReply('`$shell` "quoted" & text')).toBe(
      '`$shell` "quoted" & text',
    );
    expect(() => formatReply(' ')).toThrow(/nonempty/);
  });

  it('validates PR arguments and permits dry-run only where supported', () => {
    expect(parsePrArgs(['9'])).toEqual({ pr: 9, dryRun: false });
    expect(parsePrArgs(['--dry-run', '9'], true)).toEqual({
      pr: 9,
      dryRun: true,
    });
    for (const args of [
      [],
      ['0'],
      ['-1'],
      ['9x'],
      ['9', '10'],
      ['9', '--dry-run'],
      ['999999999999999999999'],
    ])
      expect(() => parsePrArgs(args)).toThrow();
  });
});
