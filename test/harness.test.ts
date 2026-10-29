import { describe, expect, it } from 'vitest';
import {
  appendLessons,
  extractJson,
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
      parseArgs(['--next', '--impl-model', 'gpt-x', '--max-attempts', '2']),
    ).toMatchObject({ next: true, implModel: 'gpt-x', maxAttempts: 2 });
    expect(() => parseArgs([])).toThrow(/issue number/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown/);
  });

  it('renders known placeholders and leaves unknown ones', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}');
  });

  it('extracts the last fenced JSON block, or a trailing bare object', () => {
    const reply =
      'thinking\n```json\n{"findings":[1]}\n```\nmore\n```json\n{"findings":[]}\n```';
    expect(extractJson(reply)).toEqual({ findings: [] });
    expect(extractJson('Result:\n{"lessons": []}')).toEqual({ lessons: [] });
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('```json\n{broken\n```')).toBeNull();
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
