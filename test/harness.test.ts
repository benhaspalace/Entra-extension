import { describe, expect, it } from 'vitest';
import {
  appendLessons,
  extractJson,
  isReviewResult,
  metricsLine,
  parseArgs,
  promoteRules,
  renderTemplate,
  splitFindings,
  type Finding,
} from '../scripts/harness/lib.mjs';

describe('agent harness helpers', () => {
  it('parses an issue number or --next with overrides', () => {
    expect(parseArgs(['#12', '--dry-run'])).toMatchObject({
      issue: 12,
      dryRun: true,
    });
    expect(
      parseArgs(['--next', '--impl-model', 'model-a', '--max-attempts', '2']),
    ).toMatchObject({ next: true, implModel: 'model-a', maxAttempts: 2 });
    expect(() => parseArgs([])).toThrow(/issue number/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown/);
  });

  it('renders known placeholders and leaves unknown ones', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}');
  });

  it('records agent roles rather than model identifiers in metrics', () => {
    const roles = [
      'implementation agent',
      'review agent',
      'retrospective agent',
    ];
    const line = metricsLine({
      issue: 12,
      roles,
      implModel: 'model-a',
      reviewModel: 'model-b',
      attempts: 1,
      findingCounts: { high: 0 },
      outcome: 'pr',
    });
    expect(JSON.parse(line)).toEqual({
      issue: 12,
      roles,
      attempts: 1,
      findings: { high: 0 },
      outcome: 'pr',
    });
    expect(line).not.toMatch(/model-[ab]|implModel|reviewModel/);
  });

  it('extracts the last fenced JSON block, or a trailing bare object', () => {
    const reply =
      'thinking\n```json\n{"findings":[1]}\n```\nmore\n```json\n{"findings":[]}\n```';
    expect(extractJson(reply)).toEqual({ findings: [] });
    expect(extractJson('Result:\n{"lessons": []}')).toEqual({ lessons: [] });
    expect(extractJson('{"findings": [{"severity": "high"}]}\nok')).toBeNull();
    expect(extractJson('{"findings": [{"severity": "high"}]}')).toEqual({
      findings: [{ severity: 'high' }],
    });
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('```json\n{broken\n```')).toBeNull();
  });

  it('accepts empty reviews and findings with the required fields', () => {
    expect(isReviewResult({ findings: [] })).toBe(true);
    expect(
      isReviewResult({ findings: [{ severity: 'low', summary: 'A note' }] }),
    ).toBe(true);
    expect(
      isReviewResult({
        findings: [
          {
            severity: 'high',
            summary: 'A defect',
            file: 'src/example.ts',
            line: 12,
            fix: 'Correct the defect',
            inScope: false,
          },
        ],
      }),
    ).toBe(true);
    expect(isReviewResult(null)).toBe(false);
    expect(isReviewResult({})).toBe(false);
    expect(isReviewResult({ findings: 'none' })).toBe(false);
  });

  it('accepts only review results with a valid findings array', () => {
    expect(isReviewResult({ findings: [] })).toBe(true);
    for (const severity of ['high', 'medium', 'low']) {
      expect(
        isReviewResult({ findings: [{ severity, summary: 'Check paging.' }] }),
      ).toBe(true);
    }
    expect(
      isReviewResult({
        findings: [
          {
            severity: 'medium',
            summary: 'Check paging.',
            file: 'src/shared/graph.ts',
            line: 1,
            fix: 'Follow every page.',
            inScope: false,
          },
        ],
      }),
    ).toBe(true);
    expect(isReviewResult(null)).toBe(false);
    expect(isReviewResult({})).toBe(false);
    expect(isReviewResult({ findings: 'none' })).toBe(false);
  });

  it.each([
    null,
    [],
    'defect',
    {},
    { severity: 'low' },
    { summary: 'Missing severity' },
    { severity: 'critical', summary: 'Invalid severity' },
    { severity: 'high', description: 'Wrong summary field' },
    { severity: 'high', summary: '' },
    { severity: 'high', summary: ' \n\t' },
    { severity: 'high', summary: 123 },
    { severity: 'high', summary: 'Defect', file: 123 },
    { severity: 'high', summary: 'Defect', fix: {} },
    { severity: 'high', summary: 'Defect', line: '12' },
    { severity: 'high', summary: 'Defect', line: 0 },
    { severity: 'high', summary: 'Defect', line: -1 },
    { severity: 'high', summary: 'Defect', line: 1.5 },
    { severity: 'high', summary: 'Defect', inScope: 'false' },
    { severity: 'high', summary: 'Defect', inScope: null },
  ])('rejects an entire review containing malformed finding %j', (finding) => {
    expect(
      isReviewResult({
        findings: [{ severity: 'low', summary: 'Valid note' }, finding],
      }),
    ).toBe(false);
  });

  it.each([
    {},
    [],
    { severity: 'low' },
    { severity: 'critical', summary: 'Unknown severity.' },
    { severity: 'high', summary: '' },
    { severity: 'high', summary: '   ' },
    { severity: 'high', summary: 42 },
    { severity: 'high', summary: 'Check.', file: 42 },
    { severity: 'high', summary: 'Check.', fix: null },
    { severity: 'high', summary: 'Check.', line: '1' },
    { severity: 'high', summary: 'Check.', line: 0 },
    { severity: 'high', summary: 'Check.', line: -1 },
    { severity: 'high', summary: 'Check.', line: 1.5 },
    { severity: 'high', summary: 'Check.', line: NaN },
    { severity: 'high', summary: 'Check.', line: Infinity },
    { severity: 'high', summary: 'Check.', inScope: 'false' },
  ])('rejects malformed findings instead of losing them (%j)', (finding) => {
    expect(
      isReviewResult({
        findings: [{ severity: 'low', summary: 'Valid note.' }, finding],
      }),
    ).toBe(false);
  });

  it('fixes in-scope high/medium findings and files out-of-scope ones', () => {
    const { fixNow, followUps, notes } = splitFindings([
      { severity: 'high', summary: 'a' },
      { severity: 'low', summary: 'b' },
      { severity: 'medium', summary: 'c', inScope: false },
      { severity: 'critical', summary: 'invalid' } as unknown as Finding,
      { severity: 'high', summary: '' },
    ]);
    expect(fixNow.map((f) => f.summary)).toEqual(['a']);
    expect(notes.map((f) => f.summary)).toEqual(['b']);
    expect(followUps.map((f) => f.summary)).toEqual(['c']);
  });

  it('appends only new lessons, ignoring case and punctuation', () => {
    const start = '# Lessons\n\n- Use eq on state. _(issue #1, 2026-01-01)_\n';
    const { markdown, added } = appendLessons(
      start,
      [
        { rule: 'use EQ on state' },
        { rule: 'Page every list.', evidence: 'x' },
      ],
      { issue: 7, date: '2026-10-29' },
    );
    expect(added).toEqual([{ rule: 'Page every list.', evidence: 'x' }]);
    expect(markdown).toContain(
      '- Page every list. _(issue #7, 2026-10-29: x)_',
    );
    expect(appendLessons(start, [], { issue: 1, date: 'd' }).markdown).toBe(
      start,
    );
  });

  it('promotes rules into a Learned rules section without duplicates', () => {
    const agents = '# Agent instructions\n\n## Rules\n\n- Existing rule.\n';
    const first = promoteRules(agents, ['New rule.', 'Existing rule.']);
    expect(first.added).toEqual(['New rule.']);
    expect(first.markdown).toMatch(/## Learned rules[\s\S]*- New rule\.\n$/);
    const second = promoteRules(
      `${first.markdown}\n## Commands\n\n- npm test\n`,
      ['Another rule.'],
    );
    expect(second.markdown).toMatch(
      /- New rule\.\n- Another rule\.\n\n## Commands/,
    );
  });
});
