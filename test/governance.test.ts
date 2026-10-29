import { describe, expect, it } from 'vitest';
import {
  classifyGovernance,
  packageContainsGroup,
} from '../src/shared/governance';
import type { AccessPackage, Assignment, Group } from '../src/shared/types';

const group: Group = {
  id: 'group',
  groupTypes: [],
  onPremisesSyncEnabled: false,
};
const pkg: AccessPackage = {
  id: 'package',
  displayName: 'Engineering',
  resourceRoleScopes: [
    { scope: { originId: 'GROUP', originSystem: 'AadGroup' } },
  ],
};
const assignment: Assignment = {
  id: 'assignment',
  state: 'delivered',
  target: { objectId: 'MEMBER' },
  accessPackage: { id: 'PACKAGE' },
  schedule: {
    expiration: { type: 'afterDateTime', endDateTime: '2027-01-01T00:00:00Z' },
  },
};

describe('pure membership governance', () => {
  it('requires an AadGroup scope with matching group id', () => {
    expect(packageContainsGroup(pkg, 'group')).toBe(true);
    expect(packageContainsGroup(pkg, 'another')).toBe(false);
    expect(
      packageContainsGroup({ ...pkg, resourceRoleScopes: [] }, 'group'),
    ).toBe(false);
    expect(
      packageContainsGroup(
        {
          ...pkg,
          resourceRoleScopes: [
            { scope: { originId: 'group', originSystem: 'AadApplication' } },
          ],
        },
        'group',
      ),
    ).toBe(false);
  });

  it('keeps multiple package hyperlinks and expiry; packages win over rule/sync', () => {
    const second = { ...pkg, id: 'second', displayName: 'Operations' };
    const result = classifyGovernance(
      {
        ...group,
        groupTypes: ['DynamicMembership'],
        onPremisesSyncEnabled: true,
      },
      'member',
      [pkg, second],
      [
        assignment,
        { ...assignment, id: 'a2', accessPackage: { id: 'second' } },
      ],
    );
    expect(result).toEqual({
      source: 'access-package',
      packages: [
        {
          id: 'package',
          name: 'Engineering',
          assignmentId: 'assignment',
          expiresAt: '2027-01-01T00:00:00Z',
          duration: null,
          startsAt: null,
        },
        {
          id: 'second',
          name: 'Operations',
          assignmentId: 'a2',
          expiresAt: '2027-01-01T00:00:00Z',
          duration: null,
          startsAt: null,
        },
      ],
    });
  });

  it.each(['expired', 'partiallyDelivered', 'delivering', 'deliveryFailed'])(
    'does not classify %s assignments as delivered',
    (state) => {
      expect(
        classifyGovernance(group, 'member', [pkg], [{ ...assignment, state }]),
      ).toEqual({ source: 'manual' });
    },
  );

  it('does not use another member, package or group assignment', () => {
    expect(classifyGovernance(group, 'someone', [pkg], [assignment])).toEqual({
      source: 'manual',
    });
    expect(
      classifyGovernance(
        group,
        'member',
        [pkg],
        [{ ...assignment, accessPackage: { id: 'other' } }],
      ),
    ).toEqual({ source: 'manual' });
    expect(
      classifyGovernance(
        { ...group, id: 'other' },
        'member',
        [pkg],
        [assignment],
      ),
    ).toEqual({ source: 'manual' });
  });

  it('prioritizes dynamic before synced, and supplies rule text', () => {
    expect(
      classifyGovernance(
        {
          ...group,
          groupTypes: ['DynamicMembership'],
          membershipRule: '(user.department -eq "IT")',
          onPremisesSyncEnabled: true,
        },
        'member',
        [],
        [],
      ),
    ).toEqual({ source: 'dynamic', rule: '(user.department -eq "IT")' });
    expect(
      classifyGovernance(
        { ...group, groupTypes: ['DynamicMembership'] },
        'member',
        [],
        [],
      ),
    ).toEqual({ source: 'dynamic', rule: 'Rule unavailable' });
    expect(
      classifyGovernance(
        { ...group, onPremisesSyncEnabled: true },
        'member',
        [],
        [],
      ),
    ).toEqual({ source: 'synced' });
    expect(classifyGovernance(group, 'member', [], [])).toEqual({
      source: 'manual',
    });
  });

  it('retains duration-based expiry rather than labelling it perpetual', () => {
    const result = classifyGovernance(
      group,
      'member',
      [pkg],
      [
        {
          ...assignment,
          schedule: {
            startDateTime: '2026-01-01T00:00:00Z',
            expiration: { type: 'afterDuration', duration: 'P90D' },
          },
        },
      ],
    );
    expect(
      result.source === 'access-package' && result.packages[0],
    ).toMatchObject({
      expiresAt: null,
      duration: 'P90D',
      startsAt: '2026-01-01T00:00:00Z',
    });
  });

  it('does not mutate inputs and works for each group in User > Groups', () => {
    const before = JSON.stringify({ group, pkg, assignment });
    expect(
      classifyGovernance(group, 'member', [pkg], [assignment]).source,
    ).toBe('access-package');
    expect(
      classifyGovernance({ id: 'unrelated' }, 'member', [pkg], [assignment])
        .source,
    ).toBe('manual');
    expect(JSON.stringify({ group, pkg, assignment })).toBe(before);
  });
});
