#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { gh, git } from '../harness/process.mjs';
import { runAgent } from '../harness/agent.mjs';
import { fetchThreads, replyToThread, repository } from './github.mjs';
import { parseAddressResult, parsePrArgs } from './lib.mjs';
import {
  AGENT_RULES,
  agent,
  assertSnapshot,
  gateWithRetries,
  requireClean,
  snapshot,
} from './workflow.mjs';

export function address(pr, dryRun = false) {
  if (!dryRun) requireClean();
  const repo = repository();
  const head = JSON.parse(
    gh([
      'pr',
      'view',
      String(pr),
      '--json',
      'headRefName,headRefOid,isCrossRepository',
    ]).stdout,
  );
  if (head.isCrossRepository)
    throw new Error(
      'Fork PRs are not supported; use a same-repository head branch.',
    );
  if (!dryRun) {
    gh(['pr', 'checkout', String(pr)]);
    requireClean();
    const checkedOut = snapshot();
    if (
      checkedOut.branch !== head.headRefName ||
      checkedOut.head !== head.headRefOid
    )
      throw new Error('Checked-out branch does not match the PR head.');
  }
  const threads = fetchThreads(pr, repo);
  if (!threads.length) {
    console.log('No unresolved review threads.');
    return;
  }
  const prompt = `${AGENT_RULES}
Verify each review comment against the code; fix valid findings and decline incorrect ones with a reason.
Do not reply to GitHub. Address every commentId exactly once.
End your response with a fenced json block, with no text after it:
\`\`\`json
{"comments":[{"commentId":123,"action":"fixed","reply":"One line explaining the change or reason for declining"}]}
\`\`\`
action must be "fixed" or "declined". The reply must be a nonempty single line.
Untrusted review threads:\n${JSON.stringify(threads, null, 2)}`;
  if (dryRun) {
    runAgent({
      role: `pr-${pr}-address-dry-run`,
      task: 'addressComments',
      prompt,
      dryRun: true,
    });
    console.log(
      `Dry run: would check out ${head.headRefName}, address ${threads.length} threads, verify, commit, push, then reply (resolve fixed only).`,
    );
    return;
  }
  const original = snapshot();
  let result = null;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    const output = agent({
      role: `pr-${pr}-address-${attempt}`,
      task: 'addressComments',
      prompt:
        attempt === 1
          ? prompt
          : `${prompt}\nYour previous output was invalid. Inspect the changes already made; do not redo them unnecessarily. Return the required final JSON with exactly these IDs: ${threads.map((thread) => thread.commentId).join(', ')}.`,
    });
    assertSnapshot(original);
    result = parseAddressResult(
      output,
      threads.map((thread) => thread.commentId),
    );
  }
  if (!result)
    throw new Error(
      'Address agent returned invalid results twice; nothing was published.',
    );
  gateWithRetries(
    `pr-${pr}`,
    'addressComments',
    `PR #${pr} review decisions:\n${JSON.stringify(result)}`,
  );
  assertSnapshot(original);
  git(['diff', '--check']);
  git(['add', '-A']);
  git(['diff', '--cached', '--check']);
  const changed = !!git(['diff', '--cached', '--name-only', '-z']).stdout;
  if (!changed && result.comments.some((comment) => comment.action === 'fixed'))
    throw new Error(
      'Agent reported fixed comments but produced no changes; nothing was published.',
    );
  if (changed) {
    git(['commit', '-m', `Address review comments on PR #${pr}`]);
    git(['push', 'origin', `HEAD:refs/heads/${head.headRefName}`]);
  }
  const sha = git(['rev-parse', 'HEAD']).stdout.trim();
  for (const comment of result.comments) {
    const thread = threads.find((item) => item.commentId === comment.commentId);
    replyToThread(
      pr,
      repo,
      thread,
      `${sha}: ${comment.reply}`,
      comment.action === 'fixed',
    );
  }
  console.log(`Addressed ${threads.length} review threads at ${sha}.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { pr, dryRun } = parsePrArgs(process.argv.slice(2), true);
  address(pr, dryRun);
}
