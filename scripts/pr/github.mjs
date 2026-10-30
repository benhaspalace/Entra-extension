import { gh } from '../harness/process.mjs';
import { formatReply, isTrustedReviewComment, shapeThreads } from './lib.mjs';
import { assertClean } from '../harness/terms.mjs';
import { approvalDigest, isTrustedApproval } from '../harness/issue-input.mjs';

const THREADS = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String) {
  repository(owner:$owner,name:$name) {
    pullRequest(number:$pr) {
      reviewThreads(first:100,after:$cursor) {
        nodes { id isResolved comments(first:100) {
          nodes { fullDatabaseId author { login __typename } path line body createdAt }
          pageInfo { hasNextPage endCursor }
        } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const COMMENTS = `query($id:ID!,$cursor:String) {
  node(id:$id) { ... on PullRequestReviewThread {
    comments(first:100,after:$cursor) {
      nodes { fullDatabaseId author { login __typename } path line body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  } }
}`;

export function repository() {
  return JSON.parse(gh(['repo', 'view', '--json', 'name,owner']).stdout);
}

export function permissionLookup(repo) {
  const cache = new Map();
  return (login) => {
    const key = login.toLowerCase();
    if (!cache.has(key)) {
      const permission = JSON.parse(
        gh([
          'api',
          `repos/${repo.owner.login}/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`,
        ]).stdout,
      ).permission;
      cache.set(key, permission);
    }
    return cache.get(key);
  };
}

export function partitionReviewThreads(threads, reviewBotLogin, permission) {
  const trusted = [];
  const untrusted = [];
  for (const thread of threads) {
    const comments = thread.comments;
    const isTrusted =
      Array.isArray(comments) &&
      comments.length > 0 &&
      comments.every((comment) =>
        isTrustedReviewComment(
          comment,
          reviewBotLogin,
          comment.author && comment.authorType === 'User'
            ? permission(comment.author)
            : undefined,
        ),
      );
    (isTrusted ? trusted : untrusted).push(thread);
  }
  return { trusted, untrusted };
}

export function hasReviewApproval(
  pr,
  repo,
  digest,
  permission = permissionLookup(repo),
) {
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
    if (isTrustedApproval(comment, digest, permission(comment.user.login)))
      return true;
  }
  return false;
}

export function requireReviewApproval(pr, repo, digest) {
  if (hasReviewApproval(pr, repo, digest)) return;
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
    const nodes = response.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(nodes))
      throw new Error('GitHub did not return PR review threads.');
    for (const thread of nodes) {
      if (unresolvedOnly && thread.isResolved) continue;
      let connection = thread.comments;
      const commentCursors = new Set();
      for (;;) {
        const page = connection?.pageInfo;
        if (
          !Array.isArray(connection?.nodes) ||
          typeof page?.hasNextPage !== 'boolean'
        )
          throw new Error('Missing GitHub review comment pagination.');
        if (!page.hasNextPage) break;
        if (!page.endCursor || commentCursors.has(page.endCursor))
          throw new Error('Invalid GitHub review comment pagination cursor.');
        commentCursors.add(page.endCursor);
        connection = graphql(COMMENTS, {
          id: thread.id,
          cursor: page.endCursor,
        }).data?.node?.comments;
        if (!Array.isArray(connection?.nodes))
          throw new Error('GitHub did not return complete review comments.');
        thread.comments.nodes.push(...connection.nodes);
      }
    }
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
