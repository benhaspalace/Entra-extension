import { describe, expect, it } from 'vitest';
import {
  classifyGovernance,
  isCurrentPimMember,
  packageContainsGroup,
} from '../src/shared/governance';
import type {
  AccessPackage,
  Assignment,
  Group,
  PimInstance,
} from '../src/shared/types';

const group: Group = {
  id: 'group',
  groupTypes: [],
  onPremisesSyncEnabled: false,
};
const pkg: AccessPackage = {
  id: 'package',
  displayName: 'Engineering',
  resourceRoleScopes: [
    {
      role: { originId: 'Member_GROUP' },
      scope: { originId: 'GROUP', originSystem: 'AadGroup' },
    },
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
const now = Date.parse('2026-10-30T00:00:00Z');
const pim: PimInstance = {
  id: 'pim',
  groupId: 'GROUP',
  principalId: 'MEMBER',
  accessId: 'member',
  status: 'active',
  assignmentType: 'activated',
  startDateTime: '2026-10-29T00:00:00Z',
  endDateTime: '2026-10-31T00:00:00Z',
};

describe('pure membership governance', () => {
  it('classifies current PIM member activations and assignments, preserving schedules', () => {
    const instances = [
      pim,
      { ...pim, id: 'assigned', assignmentType: 'assigned', endDateTime: null },
    ];
    const before = JSON.stringify(instances);
    expect(
      classifyGovernance(group, 'member', [], [], {
        membership: 'direct',
        pim: instances,
        now,
      }),
    ).toEqual({ source: 'pim', status: 'active', instances });
    expect(JSON.stringify(instances)).toBe(before);
  });

  it.each([
    { accessId: 'owner' },
    { accessId: 'unknownFutureValue' },
    { groupId: 'other' },
    { principalId: 'other' },
    { startDateTime: '2026-11-01T00:00:00Z' },
    { startDateTime: 'invalid' },
    { endDateTime: '2026-10-30T00:00:00Z' },
    { endDateTime: 'invalid' },
    { status: 'eligible' as const },
  ])(
    'does not attribute direct membership to unrelated/non-current PIM: %o',
    (overrides) => {
      expect(
        classifyGovernance(group, 'member', [], [], {
          membership: 'direct',
          pim: [{ ...pim, ...overrides }],
          now,
        }),
      ).toEqual({ source: 'manual' });
    },
  );

  it('keeps eligibility separate from membership, including at the schedule boundaries', () => {
    const eligible = { ...pim, status: 'eligible' as const };
    expect(
      classifyGovernance(group, 'member', [pkg], [assignment], {
        membership: 'eligible',
        pim: [eligible, pim],
        now,
      }),
    ).toEqual({ source: 'pim', status: 'eligible', instances: [eligible] });
    expect(() =>
      classifyGovernance(group, 'member', [], [], {
        membership: 'eligible',
        pim: [pim],
        now,
      }),
    ).toThrow('no current PIM eligibility');
    expect(isCurrentPimMember(pim, Date.parse(pim.startDateTime))).toBe(true);
    expect(isCurrentPimMember(pim, Date.parse(pim.endDateTime ?? ''))).toBe(
      false,
    );
  });

  it('labels transitive-only membership nested before attributing parent governance', () => {
    expect(
      classifyGovernance(
        {
          ...group,
          groupTypes: ['DynamicMembership'],
          onPremisesSyncEnabled: true,
        },
        'member',
        [pkg],
        [assignment],
        {
          membership: 'nested',
          pim: [pim],
          now,
        },
      ),
    ).toEqual({ source: 'nested' });
    expect(
      classifyGovernance(group, 'member', [pkg], [assignment], {
        membership: 'direct',
        pim: [pim],
        now,
      }).source,
    ).toBe('access-package');
    expect(
      classifyGovernance(
        {
          ...group,
          groupTypes: ['DynamicMembership'],
          onPremisesSyncEnabled: true,
        },
        'member',
        [],
        [],
        {
          membership: 'direct',
          pim: [pim],
          now,
        },
      ).source,
    ).toBe('pim');
  });

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

  it.each([
    [{ originId: 'Member_group' }, true],
    [{ displayName: 'Member' }, true],
    [{ originId: 'Owner_group', displayName: 'Owner' }, false],
    [undefined, false],
  ])('only the Member role governs membership: %o', (role, expected) => {
    const candidate: AccessPackage = {
      ...pkg,
      resourceRoleScopes: [
        {
          ...(role ? { role } : {}),
          scope: { originId: 'group', originSystem: 'AadGroup' },
        },
      ],
    };
    expect(packageContainsGroup(candidate, 'group')).toBe(expected);
    expect(
      classifyGovernance(group, 'member', [candidate], [assignment]).source,
    ).toBe(expected ? 'access-package' : 'manual');
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

  it.each(['expired', 'deliveryFailed', 'unknownFutureState'])(
    'does not classify %s assignments as active',
    (state) => {
      expect(
        classifyGovernance(group, 'member', [pkg], [{ ...assignment, state }]),
      ).toEqual({ source: 'manual' });
    },
  );

  it.each(['delivered', 'partiallyDelivered', 'delivering'])(
    'classifies %s assignments as active',
    (state) => {
      expect(
        classifyGovernance(group, 'member', [pkg], [{ ...assignment, state }])
          .source,
      ).toBe('access-package');
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
