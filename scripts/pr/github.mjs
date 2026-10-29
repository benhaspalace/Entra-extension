import { gh } from '../harness/process.mjs';
import { formatReply, shapeThreads } from './lib.mjs';
import { assertClean } from '../harness/terms.mjs';
import { approvalDigest, isTrustedApproval } from '../harness/issue-input.mjs';

const THREADS = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String) {
  repository(owner:$owner,name:$name) {
    pullRequest(number:$pr) {
      reviewThreads(first:100,after:$cursor) {
        nodes { id isResolved comments(first:1) {
          nodes { fullDatabaseId author { login } path line body }
        } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export function repository() {
  return JSON.parse(gh(['repo', 'view', '--json', 'name,owner']).stdout);
}

export function requireReviewApproval(pr, repo, digest) {
  const endpoint = `repos/${repo.owner.login}/${repo.name}`;
  const pages = JSON.parse(
    gh([
      'api',
      '--paginate',
      '--slurp',
      `${endpoint}/issues/${pr}/comments?per_page=100`,
    ]).stdout,
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
    throw new Error('GitHub did not return complete PR approval comments.');
  for (const comment of pages.flat()) {
    if (
      approvalDigest(comment) !== digest ||
      comment.user?.type !== 'User' ||
      !comment.user.login
    )
      continue;
    const permission = JSON.parse(
      gh([
        'api',
        `${endpoint}/collaborators/${encodeURIComponent(comment.user.login)}/permission`,
      ]).stdout,
    ).permission;
    if (isTrustedApproval(comment, digest, permission)) return;
  }
  throw new Error(
    'Review input is not approved. Review the saved snapshot, then have a human with current repository write access post the exact approval above.',
  );
}

export function graphql(query, variables) {
  const response = JSON.parse(
    gh(['api', 'graphql', '--input', '-'], {
      input: JSON.stringify({ query, variables }),
    }).stdout,
  );
  if (response.errors?.length)
    throw new Error(
      `GitHub GraphQL errors: ${JSON.stringify(response.errors)}`,
    );
  return response;
}

export function fetchThreads(pr, repo, unresolvedOnly = true) {
  const threads = [];
  let cursor = null;
  const seen = new Set();
  for (;;) {
    const response = graphql(THREADS, {
      owner: repo.owner.login,
      name: repo.name,
      pr,
      cursor,
    });
    threads.push(...shapeThreads(response, unresolvedOnly));
    const page = response.data.repository.pullRequest.reviewThreads.pageInfo;
    if (!page || typeof page.hasNextPage !== 'boolean')
      throw new Error('Missing GitHub review thread pagination.');
    if (!page.hasNextPage) break;
    if (!page.endCursor || seen.has(page.endCursor))
      throw new Error('Invalid GitHub review thread pagination cursor.');
    cursor = page.endCursor;
    seen.add(cursor);
  }
  return threads;
}

export function replyToThread(pr, repo, thread, message, resolve = true) {
  assertClean('Review reply', formatReply(message));
  gh(
    [
      'api',
      `repos/${repo.owner.login}/${repo.name}/pulls/${pr}/comments/${thread.commentId}/replies`,
      '--method',
      'POST',
      '--input',
      '-',
    ],
    { input: JSON.stringify({ body: formatReply(message) }) },
  );
  if (resolve) {
    const response = graphql(
      `
        mutation ($id: ID!) {
          resolveReviewThread(input: { threadId: $id }) {
            thread {
              id
              isResolved
            }
          }
        }
      `,
      { id: thread.threadId },
    );
    if (response.data?.resolveReviewThread?.thread?.isResolved !== true)
      throw new Error(
        `GitHub did not resolve review thread ${thread.threadId}.`,
      );
  }
}
