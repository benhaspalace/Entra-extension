export interface Finding {
  severity: 'high' | 'medium' | 'low';
  summary: string;
  file?: string;
  line?: number;
  fix?: string;
  inScope?: boolean;
}

export interface Lesson {
  rule: string;
  evidence?: string;
}

export interface HarnessOptions {
  issue: number | null;
  next: boolean;
  dryRun: boolean;
  noPr: boolean;
  implModel?: string;
  reviewModel?: string;
  retroModel?: string;
  maxAttempts?: number;
}

export const SEVERITIES: readonly string[];
export function parseArgs(argv: readonly string[]): HarnessOptions;
export function renderTemplate(
  template: string,
  vars: Record<string, string | number>,
): string;
export function tail(text: string | null | undefined, max?: number): string;
export function extractJson(text: string | null | undefined): unknown;
export function isReviewResult(
  value: unknown,
): value is { findings: Finding[] };
export function splitFindings(
  findings: readonly Finding[] | null | undefined,
): {
  fixNow: Finding[];
  followUps: Finding[];
  notes: Finding[];
};
export function formatFinding(finding: Finding): string;
export function appendLessons(
  markdown: string,
  lessons: readonly Lesson[] | null | undefined,
  meta: { issue: number; date: string },
): { markdown: string; added: Lesson[] };
export function promoteRules(
  agentsMd: string,
  rules: readonly (string | Lesson)[] | null | undefined,
): { markdown: string; added: string[] };
export function metricsLine(record: Record<string, unknown>): string;
