#!/usr/bin/env node
// Self-improving agent harness: GitHub issue -> Copilot implement -> gate ->
// Copilot review -> fix -> gate -> PR -> retrospective (lessons + follow-up issues).
// Usage: node scripts/harness/run.mjs <issue> | --next [--dry-run] [--no-pr]
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  appendLessons,
  extractJson,
  formatFinding,
  metricsLine,
  parseArgs,
  promoteRules,
  renderTemplate,
  splitFindings,
  tail,
} from './lib.mjs';

const ROOT = process.cwd();
const AGENTS_DIR = join(ROOT, '.agents');
const TMP = join(AGENTS_DIR, 'tmp');
const config = JSON.parse(
  readFileSync(join(AGENTS_DIR, 'harness.config.json'), 'utf8'),
);
const options = parseArgs(process.argv.slice(2));
const models = {
  impl: options.implModel ?? config.models.implement,
  review: options.reviewModel ?? config.models.review,
  retro: options.retroModel ?? config.models.retro,
};
const maxAttempts = options.maxAttempts ?? config.maxAttempts;
const isWindows = process.platform === 'win32';
const started = Date.now();

function run(command, args, { allowFail = false, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFail)
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${tail(output, 3000)}`,
    );
  return { ok: result.status === 0, output, stdout: result.stdout ?? '' };
}

const gh = (args, opts) => run('gh', args, opts);
const git = (args, opts) => run('git', args, opts);
const log = (message) => console.log(`[harness] ${message}`);

function bodyFile(name, text) {
  const path = join(TMP, name);
  writeFileSync(path, text);
  return path;
}

/** Run a Copilot CLI agent. The prompt goes through a file to avoid shell quoting. */
function copilot(role, model, prompt, { readOnly }) {
  const promptPath = bodyFile(`${role}-prompt.md`, prompt);
  const relative = promptPath.slice(ROOT.length + 1).replaceAll('\\', '/');
  const args = [
    '--model',
    model,
    '-p',
    // cmd.exe needs the quotes (copilot is a .cmd shim); spawn without a shell does not.
    isWindows
      ? `"Read ${relative} and follow it exactly."`
      : `Read ${relative} and follow it exactly.`,
    '--allow-all-tools',
    ...(readOnly ? ['--deny-tool', 'write', '--deny-tool', 'shell'] : []),
    '-s',
  ];
  log(`${role}: copilot --model ${model}${readOnly ? ' (read-only)' : ''}`);
  if (options.dryRun) return '';
  const result = run('copilot', args, { allowFail: true, shell: isWindows });
  bodyFile(`${role}-reply.md`, result.output);
  if (!result.ok)
    throw new Error(`${role} agent failed:\n${tail(result.output, 2000)}`);
  return result.stdout;
}

function gate() {
  log(`gate: ${config.gate.join(' && ')}`);
  if (options.dryRun) return { ok: true, output: '' };
  for (const command of config.gate) {
    const [bin, ...args] = command.split(' ');
    const result = run(bin, args, { allowFail: true, shell: true });
    if (!result.ok)
      return { ok: false, output: `$ ${command}\n${result.output}` };
  }
  return { ok: true, output: '' };
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
const template = (name) => read(join(AGENTS_DIR, 'prompts', `${name}.md`));

function pickIssue() {
  if (options.issue) return options.issue;
  const list = JSON.parse(
    gh([
      'issue',
      'list',
      '--label',
      config.labels.ready,
      '--state',
      'open',
      '--json',
      'number',
      '--limit',
      '100',
    ]).stdout,
  );
  if (!list.length)
    throw new Error(`No open issues labelled ${config.labels.ready}.`);
  return Math.min(...list.map((issue) => issue.number));
}

function setStatus(issue, add, comment) {
  const remove = Object.values(config.labels.status).filter(
    (label) => label !== add,
  );
  if (options.dryRun) return log(`status #${issue} -> ${add}`);
  gh(
    [
      'issue',
      'edit',
      String(issue),
      '--add-label',
      add,
      ...remove.flatMap((label) => ['--remove-label', label]),
    ],
    { allowFail: true },
  );
  if (comment)
    gh([
      'issue',
      'comment',
      String(issue),
      '--body-file',
      bodyFile('comment.md', comment),
    ]);
}

function fileFollowUps(issue, findings, source) {
  const created = [];
  for (const finding of findings) {
    const title = finding.title ?? finding.summary.slice(0, 90);
    const body = `${finding.body ?? formatFinding(finding)}\n\nFound by the ${source} agent while working on #${issue}.`;
    if (options.dryRun) {
      log(`would file issue: ${title}`);
      continue;
    }
    const result = gh([
      'issue',
      'create',
      '--title',
      title,
      '--body-file',
      bodyFile('followup.md', body),
      '--label',
      config.labels.triage,
      '--label',
      finding.label ?? config.labels.fromReview,
    ]);
    created.push(result.stdout.trim());
  }
  return created;
}

mkdirSync(TMP, { recursive: true });
const issueNumber = pickIssue();
const issue = JSON.parse(
  gh([
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'number,title,body,labels,comments,url',
  ]).stdout,
);
log(`issue #${issue.number}: ${issue.title}`);

if (!options.dryRun && git(['status', '--porcelain']).stdout.trim())
  throw new Error(
    'Working tree is not clean; commit or set aside changes first.',
  );
const base = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const branch = `agent/issue-${issue.number}`;
if (!options.dryRun) git(['switch', '-c', branch]);
setStatus(issue.number, config.labels.status.inProgress);

const record = {
  date: new Date().toISOString().slice(0, 10),
  issue: issue.number,
  implModel: models.impl,
  reviewModel: models.review,
  attempts: 0,
  gateFailures: [],
  findingCounts: { high: 0, medium: 0, low: 0, followUps: 0 },
  lessonsAdded: 0,
  rulesPromoted: 0,
  outcome: 'unknown',
};

const issueText = `# #${issue.number} ${issue.title}\n\n${issue.body}\n\n${(
  issue.comments ?? []
)
  .map((comment) => `> ${comment.author?.login}: ${comment.body}`)
  .join('\n\n')}`;
const shared = {
  issue: issueText,
  lessons: read(join(AGENTS_DIR, 'LESSONS.md')),
  gate: config.gate.join(' && '),
};

try {
  // 1. Implement, with gate-feedback retries.
  let prompt = renderTemplate(template('implement'), shared);
  let result = { ok: false, output: '' };
  while (record.attempts < maxAttempts) {
    record.attempts++;
    copilot(`implement-${record.attempts}`, models.impl, prompt, {
      readOnly: false,
    });
    result = gate();
    if (result.ok) break;
    record.gateFailures.push(tail(result.output, 400));
    prompt = renderTemplate(template('fix'), {
      ...shared,
      problems: `The quality gate failed:\n\n\`\`\`\n${tail(result.output)}\n\`\`\``,
    });
  }
  if (!result.ok)
    throw new Error(`Gate still failing after ${maxAttempts} attempts.`);

  // 2. Independent review by a different model.
  // Stage everything so new files show up in the diff; the commit below stages again anyway.
  if (!options.dryRun) git(['add', '-A']);
  const diff = git(['diff', '--cached', base]).stdout;
  const review = extractJson(
    copilot(
      'review',
      models.review,
      renderTemplate(template('review'), {
        ...shared,
        diff: tail(diff, 80000),
      }),
      { readOnly: true },
    ),
  );
  const { fixNow, followUps, notes } = splitFindings(review?.findings);
  for (const finding of review?.findings ?? [])
    if (finding?.severity in record.findingCounts)
      record.findingCounts[finding.severity]++;

  // 3. Fix in-scope findings, then re-gate.
  if (fixNow.length) {
    copilot(
      'review-fix',
      models.impl,
      renderTemplate(template('fix'), {
        ...shared,
        problems: `An independent reviewer found:\n\n${fixNow.map(formatFinding).join('\n')}\n\nVerify each finding against the code before changing it; skip ones that are wrong and say why.`,
      }),
      { readOnly: false },
    );
    record.attempts++;
    result = gate();
    if (!result.ok) {
      record.gateFailures.push(tail(result.output, 400));
      throw new Error('Gate failed after applying review fixes.');
    }
  }

  // 4. Retrospective: lessons for future runs + harness improvement ideas.
  const retro = extractJson(
    copilot(
      'retro',
      models.retro,
      renderTemplate(template('retro'), {
        ...shared,
        agents: read(join(ROOT, 'AGENTS.md')),
        run: JSON.stringify(
          {
            ...record,
            reviewFindings: review?.findings ?? [],
            gateFailures: record.gateFailures,
          },
          null,
          2,
        ),
      }),
      { readOnly: true },
    ),
  );
  const lessons = appendLessons(
    read(join(AGENTS_DIR, 'LESSONS.md')),
    retro?.lessons,
    {
      issue: issue.number,
      date: record.date,
    },
  );
  const promoted = promoteRules(read(join(ROOT, 'AGENTS.md')), retro?.promote);
  record.lessonsAdded = lessons.added.length;
  record.rulesPromoted = promoted.added.length;
  if (!options.dryRun) {
    writeFileSync(join(AGENTS_DIR, 'LESSONS.md'), lessons.markdown);
    writeFileSync(join(ROOT, 'AGENTS.md'), promoted.markdown);
  }
  const harnessIdeas = (retro?.harnessIssues ?? []).map((idea) => ({
    ...idea,
    summary: idea.title ?? 'Harness improvement',
    label: config.labels.harness,
  }));
  const filed = fileFollowUps(
    issue.number,
    [...followUps, ...harnessIdeas],
    'review/retro',
  );
  record.findingCounts.followUps = filed.length;

  // 5. Commit, push, PR.
  record.outcome = 'pr';
  record.durationSec = Math.round((Date.now() - started) / 1000);
  if (!options.dryRun)
    appendFileSync(
      join(AGENTS_DIR, 'metrics.jsonl'),
      `${metricsLine(record)}\n`,
    );
  const prBody = [
    `Closes #${issue.number}\n`,
    `Implemented by \`${models.impl}\`, reviewed by \`${models.review}\` via \`scripts/harness/run.mjs\`.`,
    `Gate (\`${shared.gate}\`) passed after ${record.attempts} attempt(s).`,
    fixNow.length
      ? `\n### Review findings fixed\n${fixNow.map(formatFinding).join('\n')}`
      : '',
    notes.length
      ? `\n### Low-severity notes (not fixed)\n${notes.map(formatFinding).join('\n')}`
      : '',
    filed.length
      ? `\n### Follow-up issues filed\n${filed.map((url) => `- ${url}`).join('\n')}`
      : '',
    lessons.added.length
      ? `\n### Lessons recorded in .agents/LESSONS.md\n${lessons.added.map((lesson) => `- ${lesson.rule}`).join('\n')}`
      : '',
    promoted.added.length
      ? `\n### Rules promoted to AGENTS.md — please check these\n${promoted.added.map((rule) => `- ${rule}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (options.dryRun) {
    log(`dry run complete. PR body would be:\n${prBody}`);
  } else {
    git(['add', '-A']);
    git([
      'commit',
      '-q',
      '-m',
      `${issue.title}\n\nCloses #${issue.number}. Generated by the agent harness.`,
    ]);
    if (!options.noPr) {
      git(['push', '-u', 'origin', branch]);
      const pr = gh([
        'pr',
        'create',
        '--base',
        base,
        '--head',
        branch,
        '--title',
        issue.title,
        '--body-file',
        bodyFile('pr.md', prBody),
      ]).stdout.trim();
      setStatus(
        issue.number,
        config.labels.status.inReview,
        `Agent harness opened ${pr}.`,
      );
      log(`PR: ${pr}`);
    }
  }
} catch (error) {
  record.outcome = 'needs-human';
  record.durationSec = Math.round((Date.now() - started) / 1000);
  if (!options.dryRun)
    appendFileSync(
      join(AGENTS_DIR, 'metrics.jsonl'),
      `${metricsLine(record)}\n`,
    );
  setStatus(
    issue.number,
    config.labels.status.needsHuman,
    `Agent harness stopped on branch \`${branch}\`:\n\n\`\`\`\n${tail(String(error.message), 3000)}\n\`\`\``,
  );
  console.error(`[harness] ${error.message}`);
  process.exitCode = 1;
}
