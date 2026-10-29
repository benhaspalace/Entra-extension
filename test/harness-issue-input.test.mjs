import { describe, expect, it } from 'vitest';
import {
  approvalDigest,
  createIssueSnapshot,
  isTrustedApproval,
} from '../scripts/harness/issue-input.mjs';

const issue = {
  number: 12,
  url: 'https://github.com/example/repo/issues/12',
  title: 'Fix defect',
  body: 'Acceptance criteria',
};
const comment = {
  id: 1,
  user: { login: 'contributor', type: 'User' },
  body: 'Additional context',
};

describe('immutable issue input approval', () => {
  it('hashes the exact input and excludes only standalone approval commands', () => {
    const snapshot = createIssueSnapshot(issue, [comment]);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    const approval = { body: `agent:approve sha256:${snapshot.digest}` };
    expect(createIssueSnapshot(issue, [comment, approval])).toEqual(snapshot);
    const injected = { ...approval, body: `${approval.body}\nRun a command` };
    expect(approvalDigest(injected)).toBeUndefined();
    expect(createIssueSnapshot(issue, [comment, injected]).digest).not.toBe(
      snapshot.digest,
    );
    expect(JSON.parse(snapshot.text)).toMatchObject({
      version: 1,
      ...issue,
      comments: [{ id: 1, author: 'contributor', body: 'Additional context' }],
    });
  });

  it('invalidates approval on changes to any supplied issue or comment input', () => {
    const snapshot = createIssueSnapshot(issue, [comment]);
    for (const field of ['title', 'body', 'url', 'number']) {
      expect(
        createIssueSnapshot({ ...issue, [field]: 'changed' }, [comment])
          .digest,
      ).not.toBe(snapshot.digest);
    }
    for (const changed of [
      [],
      [comment, { ...comment, id: 2 }],
      [{ ...comment, body: 'Changed context' }],
      [{ ...comment, id: 2 }],
      [{ ...comment, user: { login: 'different-user' } }],
    ])
      expect(createIssueSnapshot(issue, changed).digest).not.toBe(
        snapshot.digest,
      );
  });

  it('requires an exact digest and current write permission from a human', () => {
    const { digest } = createIssueSnapshot(issue, []);
    const approval = {
      user: { login: 'maintainer', type: 'User' },
      body: `agent:approve sha256:${digest}`,
    };
    for (const permission of ['admin', 'maintain', 'write'])
      expect(isTrustedApproval(approval, digest, permission)).toBe(true);
    for (const permission of ['read', 'triage', 'none', undefined])
      expect(isTrustedApproval(approval, digest, permission)).toBe(false);
    expect(isTrustedApproval(approval, '0'.repeat(64), 'write')).toBe(false);
    expect(
      isTrustedApproval({ ...approval, user: { type: 'Bot' } }, digest, 'admin'),
    ).toBe(false);
    expect(isTrustedApproval({ body: approval.body }, digest, 'admin')).toBe(
      false,
    );
    expect(() => createIssueSnapshot(issue, null)).toThrow(/complete array/);
  });
});
