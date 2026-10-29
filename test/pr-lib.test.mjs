import { describe, expect, it } from 'vitest';
import fixture from './fixtures/review-threads.json';
import {
  formatReply,
  isAddressResult,
  parseAddressResult,
  parsePrArgs,
  shapeThreads,
} from '../scripts/pr/lib.mjs';
import { resolveModel } from '../scripts/harness/copilot.mjs';
import config from '../.agents/harness.config.json';

describe('Copilot model routing', () => {
  it.each([
    ['implement', 'gpt-6.1-sol'],
    ['review', 'claude-opus-5.5'],
    ['retro', 'claude-opus-5.5'],
    ['addressComments', 'gpt-6.1-sol'],
    ['triage', 'claude-haiku-5.5'],
  ])('routes %s to %s', (task, model) => {
    expect(resolveModel(task, config)).toBe(model);
  });

  it('rejects unknown tasks, inherited properties, and unsafe model IDs', () => {
    for (const task of ['missing', 'toString', '__proto__'])
      expect(() => resolveModel(task, config)).toThrow(/No Copilot model/);
    for (const model of ['', null, 123, 'model & echo bad'])
      expect(() =>
        resolveModel('implement', { models: { implement: model } }),
      ).toThrow(/Invalid/);
    expect(() => resolveModel('implement', {})).toThrow();
  });
});

describe('PR pure helpers', () => {
  it('shapes unresolved GraphQL review threads and preserves unavailable metadata', () => {
    expect(shapeThreads(fixture)).toEqual([
      {
        threadId: 'thread-open',
        commentId: 123,
        author: 'reviewer',
        path: 'src/shared/graph.ts',
        line: 42,
        body: 'Please follow the next page.',
      },
      {
        threadId: 'thread-outdated',
        commentId: 125,
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

  it('formats the exact attribution footer without interpreting the message', () => {
    expect(formatReply('  abc123: Fixed it. \n')).toBe(
      'abc123: Fixed it.\n\n_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_',
    );
    expect(formatReply('`$shell` "quoted" & text')).toContain(
      '`$shell` "quoted" & text\n\n',
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
