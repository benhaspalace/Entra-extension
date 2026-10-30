import { describe, expect, it } from 'vitest';
import fixture from './fixtures/review-state.json';
import {
  checkReviewState,
  findingTitle,
  isTrustSurface,
  parseReviewMarker,
} from '../scripts/pr/review-state.mjs';
import { reviewMarker, reviewSettings } from '../scripts/pr/review-config.mjs';

const config = {
  reviewBotLogin: 'review-bot',
  reviewTriggers: ['request code', 'request security'],
  reviewStateMarker: 'review-state:v1',
};
const input = () => ({
  ...globalThis.structuredClone(fixture),
  config,
  trustedRequest: (comment) =>
    comment.user?.type === 'User' && comment.user.login === 'owner',
  now: Date.parse('2026-10-30T12:10:00Z'),
});
const root = (overrides = {}) => ({
  author: 'review-bot',
  authorType: 'Bot',
  path: 'src/shared/graph.ts',
  body: '**[P1] Follow all pages**',
  createdAt: '2026-10-30T12:02:00Z',
  ...overrides,
});
const reply = (overrides = {}) => ({
  author: 'owner',
  authorType: 'User',
  body: 'Fixed in aaaaaaa: Added paging. Added a paging test.',
  createdAt: '2026-10-30T12:03:00Z',
  ...overrides,
});

describe('review readiness fixtures', () => {
  it('accepts clean receipts for both current-head reviews', () => {
    expect(checkReviewState(input())).toEqual({ exitCode: 0, reasons: [] });
  });

  it('requires a non-bot reply even when the thread has been resolved', () => {
    const data = input();
    data.threads = [
      { isResolved: true, comments: [root(), reply({ authorType: 'Bot' })] },
    ];
    expect(checkReviewState(data)).toMatchObject({ exitCode: 1 });
    expect(checkReviewState(data).reasons.join()).toContain('non-bot reply');
    data.threads[0].comments.push(reply());
    expect(checkReviewState(data).exitCode).toBe(0);
  });

  it('rejects stale summary SHAs and stale or missing receipts', () => {
    for (const index of [2, 3, 4]) {
      const data = input();
      data.comments[index].body = data.comments[index].body.replaceAll(
        data.headSha,
        'b'.repeat(40),
      );
      expect(checkReviewState(data).exitCode).toBe(1);
    }
    const data = input();
    data.comments.pop();
    expect(checkReviewState(data).reasons.join()).toContain('security');
  });

  it('requires fresh receipts after a new authorized request on the same head', () => {
    const data = input();
    data.comments.push({
      ...data.comments[0],
      id: 110,
      created_at: '2026-10-30T12:05:00Z',
    });
    expect(checkReviewState(data).exitCode).toBe(1);
  });

  it('detects an answered finding recurring later by file and normalized title', () => {
    const data = input();
    data.threads = [
      { comments: [root(), reply()] },
      {
        comments: [
          root({
            createdAt: '2026-10-30T12:04:00Z',
            body: '### [P2] Follow all pages',
          }),
        ],
      },
    ];
    expect(checkReviewState(data)).toMatchObject({ exitCode: 3 });
    expect(checkReviewState(data).reasons.join()).toContain('Review loop');
    data.threads[1].comments[0].path = 'other.ts';
    expect(checkReviewState(data).exitCode).toBe(1);
    data.threads[1].comments[0].path = 'src/shared/graph.ts';
    data.threads[1].comments[0].createdAt = '2026-10-30T12:02:30Z';
    expect(checkReviewState(data).exitCode).toBe(1);
  });

  it('times out at exactly 30 minutes, but not before or after a completed review', () => {
    const data = input();
    data.comments = data.comments.slice(0, 2);
    data.now = Date.parse('2026-10-30T12:29:59.999Z');
    expect(checkReviewState(data).exitCode).toBe(1);
    data.now++;
    expect(checkReviewState(data)).toMatchObject({ exitCode: 3 });
    expect(checkReviewState(data).reasons.join()).toContain('30 minutes');
    expect(checkReviewState({ ...input(), now: data.now }).exitCode).toBe(0);
  });

  it('applies timeout while a summary says the review is still running', () => {
    const data = input();
    data.comments = data.comments.slice(0, 3);
    data.comments[2].body = reviewMarker(config.reviewStateMarker, {
      headSha: data.headSha,
      reviews: { code: { status: 'running' }, security: { status: 'pending' } },
    });
    data.now = Date.parse('2026-10-30T12:30:00Z');
    expect(checkReviewState(data).exitCode).toBe(3);
  });

  it('ignores requests from outsiders, bots, and old heads for the timeout', () => {
    for (const user of [
      { login: 'outsider', type: 'User' },
      { login: 'owner', type: 'Bot' },
    ]) {
      const data = input();
      data.comments = data.comments
        .slice(0, 2)
        .map((comment) => ({ ...comment, user }));
      data.now = Date.parse('2026-10-30T13:00:00Z');
      expect(checkReviewState(data).exitCode).toBe(1);
    }
    const data = input();
    data.headSha = 'b'.repeat(40);
    data.now = Date.parse('2026-10-30T13:00:00Z');
    expect(checkReviewState(data).exitCode).toBe(1);
  });

  it('does not trust matching logins without Bot type, or other bots', () => {
    for (const user of [
      { login: 'review-bot', type: 'User' },
      { login: 'different', type: 'Bot' },
    ]) {
      const data = input();
      for (const comment of data.comments.slice(2)) comment.user = user;
      expect(checkReviewState(data).exitCode).toBe(1);
    }
  });

  it('fails closed on malformed, duplicate, or incompatible trusted markers', () => {
    for (const body of [
      '<!-- review-state:v1 broken -->',
      '<!-- review-state:v1 {"headSha":"bad"} -->',
      `${fixture.comments[2].body}\n${fixture.comments[2].body}`,
    ]) {
      const data = input();
      data.comments[2].body = body;
      expect(checkReviewState(data).exitCode).toBe(1);
    }
    const data = input();
    data.comments.push({
      user: { login: 'outsider', type: 'User' },
      body: '<!-- review-state:v1:request broken -->',
    });
    expect(checkReviewState(data).exitCode).toBe(0);
  });

  it('requires clean security specifically for every trust-surface path and renames away from it', () => {
    const data = input();
    for (const index of [2, 3, 4])
      data.comments[index].body = data.comments[index].body.replaceAll(
        '"clean":true',
        '"clean":false',
      );
    expect(checkReviewState(data).exitCode).toBe(0);
    for (const filename of [
      '.github/workflows/ci.yml',
      'AGENTS.md',
      '.agents/LESSONS.md',
      'scripts/ci.mjs',
      'package.json',
      'package-lock.json',
      'manifest.json',
    ]) {
      data.files = [filename];
      expect(isTrustSurface(filename)).toBe(true);
      expect(checkReviewState(data).reasons.join()).toContain(
        'clean security review',
      );
      data.files = [{ filename: 'other.txt', previous_filename: filename }];
      expect(checkReviewState(data).exitCode).toBe(1);
    }
  });

  it.each([
    { mergeable: 'UNKNOWN' },
    { mergeable: 'CONFLICTING' },
    { isDraft: true },
    { state: 'CLOSED' },
    { state: undefined },
    { isDraft: undefined },
  ])('blocks PRs that are not mergeable: %j', (overrides) => {
    expect(checkReviewState({ ...input(), ...overrides }).exitCode).toBe(1);
  });

  it('allows automatic opening reviews without manual requests only with null request IDs', () => {
    const data = input();
    data.comments = data.comments.slice(2).map((comment) => ({
      ...comment,
      body: comment.body.replace(/"requestId":10[12]/g, '"requestId":null'),
    }));
    expect(checkReviewState(data).exitCode).toBe(0);
  });

  it('checks finding timestamps instead of silently missing a loop', () => {
    const data = input();
    data.threads = [{ comments: [root({ createdAt: undefined }), reply()] }];
    expect(checkReviewState(data).reasons.join()).toContain('timestamps');
  });

  it('rejects request markers without a valid comment ID', () => {
    const data = input();
    data.comments[0].id = null;
    expect(checkReviewState(data).reasons.join()).toContain('request schema');
  });
});

describe('review configuration and markers', () => {
  it('normalizes identities, copies triggers and allows environment configuration', () => {
    const local = { ...config, reviewBotLogin: 'Review-Bot[bot]' };
    expect(reviewSettings(local, {})).toEqual(config);
    expect(
      reviewSettings(
        {},
        {
          REVIEW_BOT_LOGIN: 'review-bot',
          REVIEW_TRIGGERS: JSON.stringify(config.reviewTriggers),
          REVIEW_STATE_MARKER: config.reviewStateMarker,
        },
      ),
    ).toEqual(config);
    expect(reviewSettings(local, {}).reviewTriggers).not.toBe(
      local.reviewTriggers,
    );
  });

  it('rejects missing triggers and unsafe markers', () => {
    for (const reviewTriggers of [
      [],
      ['one'],
      ['one', 'one'],
      ['one\nextra', 'two'],
      null,
    ])
      expect(() => reviewSettings({ ...config, reviewTriggers }, {})).toThrow(
        /reviewTriggers/,
      );
    expect(() =>
      reviewSettings({ ...config, reviewStateMarker: '<!--' }, {}),
    ).toThrow(/reviewStateMarker/);
  });

  it('only parses exact hidden markers and normalizes titles', () => {
    expect(
      parseReviewMarker('ordinary prose', config.reviewStateMarker),
    ).toBeNull();
    expect(
      parseReviewMarker(fixture.comments[3].body, config.reviewStateMarker),
    ).toBeNull();
    expect(findingTitle('**[P1] Follow all pages**\nDetails')).toBe(
      'follow all pages',
    );
  });
});
