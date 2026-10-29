import { createHash } from 'node:crypto';

const APPROVAL = /^agent:approve sha256:([a-f0-9]{64})$/;

export function approvalDigest(comment) {
  return typeof comment.body === 'string'
    ? APPROVAL.exec(comment.body)?.[1]
    : undefined;
}

export function createIssueSnapshot(issue, comments) {
  if (!Array.isArray(comments))
    throw new Error('Issue comments must be a complete array.');
  const input = {
    version: 1,
    url: issue.url,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    comments: comments
      .filter((comment) => !approvalDigest(comment))
      .map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? null,
        body: comment.body ?? '',
      })),
  };
  const text = JSON.stringify(input, null, 2);
  return {
    text,
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

export function isTrustedApproval(comment, digest, permission) {
  return (
    approvalDigest(comment) === digest &&
    comment.user?.type === 'User' &&
    ['admin', 'maintain', 'write'].includes(permission)
  );
}
