import { createHash } from 'node:crypto';
import { extractJson } from '../harness/lib.mjs';

export function createReviewSnapshot(repo, pr, head, threads) {
  const text = JSON.stringify(
    {
      version: 1,
      repository: `${repo.owner.login}/${repo.name}`,
      pr,
      head: { branch: head.headRefName, sha: head.headRefOid },
      threads,
    },
    null,
    2,
  );
  return {
    text,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

export function formatReply(message) {
  if (typeof message !== 'string' || !message.trim())
    throw new Error('A nonempty reply message is required.');
  return message.trim();
}

export function normalizeReviewBotLogin(login) {
  if (
    typeof login !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/.test(login)
  )
    throw new Error(
      'Missing or invalid review bot login (REVIEW_BOT_LOGIN). Set REVIEW_BOT_LOGIN or reviewBotLogin in .agents/harness.local.json to a valid bot login.',
    );
  return login.replace(/\[bot\]$/, '').toLowerCase();
}

export function isTrustedReviewComment(comment, reviewBotLogin, permission) {
  if (!comment.author) return false;
  return (
    (comment.authorType === 'Bot' &&
      comment.author.toLowerCase().replace(/\[bot\]$/, '') ===
        normalizeReviewBotLogin(reviewBotLogin)) ||
    (comment.authorType === 'User' &&
      ['write', 'maintain', 'admin'].includes(permission))
  );
}

function shapeComment(comment) {
  const rawId = comment?.fullDatabaseId;
  const commentId =
    typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId)
      ? Number(rawId)
      : rawId;
  if (!Number.isSafeInteger(commentId) || commentId <= 0)
    throw new Error('GitHub returned a review thread without a root comment.');
  return {
    commentId,
    author: comment.author?.login ?? null,
    authorType: comment.author?.__typename ?? null,
    path: comment.path,
    line: comment.line ?? null,
    body: comment.body,
  };
}

export function shapeThreads(response, unresolvedOnly = true) {
  if (response.errors?.length)
    throw new Error(
      `GitHub GraphQL errors: ${JSON.stringify(response.errors)}`,
    );
  const connection = response.data?.repository?.pullRequest?.reviewThreads;
  if (!Array.isArray(connection?.nodes))
    throw new Error('GitHub did not return PR review threads.');
  return connection.nodes
    .filter((thread) => !unresolvedOnly || !thread.isResolved)
    .map((thread) => {
      if (!thread.id || !thread.comments?.nodes?.length)
        throw new Error(
          'GitHub returned a review thread without a root comment.',
        );
      const comments = thread.comments.nodes.map(shapeComment);
      return {
        threadId: thread.id,
        ...comments[0],
        comments,
      };
    });
}

export function isAddressResult(value, expectedIds) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.comments))
    return false;
  const ids = new Set();
  for (const comment of value.comments) {
    if (
      !comment ||
      !Number.isSafeInteger(comment.commentId) ||
      comment.commentId <= 0 ||
      ids.has(comment.commentId) ||
      !['fixed', 'declined'].includes(comment.action) ||
      typeof comment.reply !== 'string' ||
      !comment.reply.trim() ||
      /[\r\n]/.test(comment.reply)
    )
      return false;
    ids.add(comment.commentId);
  }
  return (
    !expectedIds ||
    (ids.size === expectedIds.length && expectedIds.every((id) => ids.has(id)))
  );
}

export function parseAddressResult(text, expectedIds) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const finalBlock = blocks.at(-1);
  if (!finalBlock || text.slice(finalBlock.index + finalBlock[0].length).trim())
    return null;
  const value = extractJson(finalBlock[0]);
  return isAddressResult(value, expectedIds) ? value : null;
}

export function parsePrArgs(argv, allowDryRun = false) {
  const dryRun = allowDryRun && argv.includes('--dry-run');
  const positional = argv.filter(
    (arg) => !(allowDryRun && arg === '--dry-run'),
  );
  if (positional.length !== 1 || !/^[1-9]\d*$/.test(positional[0]))
    throw new Error(
      'Pass a positive PR number' + (allowDryRun ? ' [--dry-run].' : '.'),
    );
  const pr = Number(positional[0]);
  if (!Number.isSafeInteger(pr)) throw new Error('Invalid PR number.');
  return { pr, dryRun };
}
