// Pure helpers for the agent harness. Kept free of I/O so they can be unit tested.

export const SEVERITIES = ['high', 'medium', 'low'];

export function parseArgs(argv) {
  const options = { issue: null, next: false, dryRun: false, noPr: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--next') options.next = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-pr') options.noPr = true;
    else if (arg === '--impl-model') options.implModel = argv[++index];
    else if (arg === '--review-model') options.reviewModel = argv[++index];
    else if (arg === '--retro-model') options.retroModel = argv[++index];
    else if (arg === '--max-attempts')
      options.maxAttempts = Number(argv[++index]);
    else if (/^#?\d+$/.test(arg)) options.issue = Number(arg.replace('#', ''));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.issue && !options.next)
    throw new Error('Pass an issue number or --next.');
  return options;
}

export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match,
  );
}

export function tail(text, max = 6000) {
  if (!text) return '';
  return text.length <= max ? text : `…(truncated)…\n${text.slice(-max)}`;
}

/** Return the last ```json fenced block (or bare JSON object) in an agent reply. */
export function extractJson(text) {
  const fenced = [...(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidates = fenced.map((match) => match[1]).reverse();
  if (text) candidates.push(text);
  const start = text?.lastIndexOf('\n{');
  if (start !== undefined && start >= 0) candidates.push(text.slice(start + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** A review result must be an object with a findings array, or the change counts as unreviewed. */
export function isReviewResult(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray(value.findings) &&
    value.findings.every((finding) => finding && typeof finding === 'object')
  );
}

/** In-scope high/medium findings are fixed now; out-of-scope ones become issues. */
export function splitFindings(findings) {
  const valid = (findings ?? []).filter(
    (finding) =>
      finding && SEVERITIES.includes(finding.severity) && finding.summary,
  );
  return {
    fixNow: valid.filter(
      (finding) => finding.inScope !== false && finding.severity !== 'low',
    ),
    followUps: valid.filter((finding) => finding.inScope === false),
    notes: valid.filter(
      (finding) => finding.inScope !== false && finding.severity === 'low',
    ),
  };
}

export function formatFinding(finding) {
  const where = finding.file
    ? ` (\`${finding.file}${finding.line ? `:${finding.line}` : ''}\`)`
    : '';
  const fix = finding.fix ? ` Fix: ${finding.fix}` : '';
  return `- **${finding.severity}**${where}: ${finding.summary}${fix}`;
}

const normalise = (rule) => rule.toLowerCase().replace(/\W+/g, ' ').trim();

/** Append new candidate lessons, skipping ones already recorded. */
export function appendLessons(markdown, lessons, meta) {
  const known = new Set(
    [...markdown.matchAll(/^- (.+?)(?: _\(|$)/gm)].map((match) =>
      normalise(match[1]),
    ),
  );
  const fresh = (lessons ?? []).filter(
    (lesson) => lesson?.rule && !known.has(normalise(lesson.rule)),
  );
  if (!fresh.length) return { markdown, added: [] };
  const lines = fresh.map(
    (lesson) =>
      `- ${lesson.rule.trim()} _(issue #${meta.issue}, ${meta.date}${lesson.evidence ? `: ${lesson.evidence.trim()}` : ''})_`,
  );
  const body = markdown.trimEnd();
  return { markdown: `${body}\n${lines.join('\n')}\n`, added: fresh };
}

/** Add promoted rules to the "## Learned rules" section of AGENTS.md. */
export function promoteRules(agentsMd, rules) {
  const heading = '## Learned rules';
  const existing = new Set(
    [...agentsMd.matchAll(/^- (.+)$/gm)].map((match) => normalise(match[1])),
  );
  const fresh = (rules ?? [])
    .map((rule) => (typeof rule === 'string' ? rule : rule?.rule))
    .filter((rule) => rule && !existing.has(normalise(rule)));
  if (!fresh.length) return { markdown: agentsMd, added: [] };
  const bullets = fresh.map((rule) => `- ${rule.trim()}`).join('\n');
  if (!agentsMd.includes(heading))
    return {
      markdown: `${agentsMd.trimEnd()}\n\n${heading}\n\nPromoted from \`.agents/LESSONS.md\` after recurring in runs. Keep each rule short and checkable.\n\n${bullets}\n`,
      added: fresh,
    };
  const start = agentsMd.indexOf(heading);
  const nextHeading = agentsMd.indexOf('\n## ', start + heading.length);
  const end = nextHeading < 0 ? agentsMd.length : nextHeading;
  const section = agentsMd.slice(start, end).trimEnd();
  const separator = /^- /m.test(section) ? '\n' : '\n\n';
  return {
    markdown: `${agentsMd.slice(0, start)}${section}${separator}${bullets}\n${agentsMd.slice(end)}`,
    added: fresh,
  };
}

export function metricsLine(record) {
  return JSON.stringify({
    date: record.date,
    issue: record.issue,
    roles: record.roles,
    attempts: record.attempts,
    gateFailures: record.gateFailures,
    findings: record.findingCounts,
    lessonsAdded: record.lessonsAdded,
    rulesPromoted: record.rulesPromoted,
    outcome: record.outcome,
    durationSec: record.durationSec,
  });
}
