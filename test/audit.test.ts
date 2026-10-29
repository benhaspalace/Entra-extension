import { describe, expect, it } from 'vitest';
import { matchAudit } from '../src/shared/audit';
import type { DirectoryAudit } from '../src/shared/types';

const event: DirectoryAudit = {
  id: 'event',
  result: 'success',
  activityDisplayName: 'Add member to group',
  activityDateTime: '2026-10-01T12:00:00Z',
  initiatedBy: { user: { userPrincipalName: 'admin@example.com' } },
  targetResources: [{ id: 'MEMBER' }, { id: 'GROUP' }],
};

describe('audit matching', () => {
  it('matches both member and group, ignores case and returns the user actor', () => {
    expect(matchAudit([event], 'group', 'member')).toEqual({
      actor: 'admin@example.com',
      when: event.activityDateTime,
      historicalPackage: false,
    });
  });
  it('matches JSON-quoted and unquoted Group.ObjectID modified properties', () => {
    for (const value of ['"group"', 'GROUP']) {
      expect(
        matchAudit(
          [
            {
              ...event,
              targetResources: [
                {
                  id: 'member',
                  modifiedProperties: [
                    { displayName: 'Group.ObjectID', newValue: value },
                  ],
                },
              ],
            },
          ],
          'group',
          'member',
        ),
      ).not.toBeNull();
    }
  });
  it('does not match substrings or a different group/member', () => {
    expect(matchAudit([event], 'group-other', 'member')).toBeNull();
    expect(matchAudit([event], 'group', 'other')).toBeNull();
    expect(
      matchAudit(
        [
          {
            ...event,
            targetResources: [
              {
                id: 'member',
                modifiedProperties: [
                  { displayName: 'Group.ObjectID', newValue: '"group-other"' },
                ],
              },
            ],
          },
        ],
        'group',
        'member',
      ),
    ).toBeNull();
  });
  it.each([
    { result: 'failure' },
    { activityDisplayName: 'Remove member from group' },
    { activityDateTime: 'not-a-date' },
    { targetResources: [] },
  ])('rejects irrelevant events: %o', (changes) => {
    expect(
      matchAudit([{ ...event, ...changes }], 'group', 'member'),
    ).toBeNull();
  });
  it('rejects events without timestamps', () => {
    const candidate = { ...event };
    delete candidate.activityDateTime;
    expect(matchAudit([candidate], 'group', 'member')).toBeNull();
  });
  it('chooses the newest successful event, without mutating input order', () => {
    const events = [
      event,
      {
        ...event,
        id: 'latest',
        activityDateTime: '2026-10-20T12:00:00Z',
        initiatedBy: { app: { displayName: 'Automation' } },
      },
    ];
    expect(matchAudit(events, 'group', 'member')?.actor).toBe('Automation');
    expect(events[0]).toBe(event);
  });
  it('labels identity governance service actors as historical, not current packages', () => {
    expect(
      matchAudit(
        [
          {
            ...event,
            initiatedBy: {
              app: { displayName: 'Microsoft Entra Entitlement Management' },
            },
          },
        ],
        'group',
        'member',
      )?.historicalPackage,
    ).toBe(true);
    expect(
      matchAudit(
        [
          {
            ...event,
            initiatedBy: {
              app: { displayName: 'Custom Entitlement Management tool' },
            },
          },
        ],
        'group',
        'member',
      )?.historicalPackage,
    ).toBe(true);
  });
  it.each([
    ['Service - IDENTITY GOVERNANCE (tenant)', true],
    ['Custom eNtItLeMeNt MaNaGeMeNt tool', true],
    ['Group management automation', false],
  ])(
    'matches historical service names by case-insensitive substring: %s',
    (displayName, historicalPackage) => {
      expect(
        matchAudit(
          [{ ...event, initiatedBy: { app: { displayName } } }],
          'group',
          'member',
        )?.historicalPackage,
      ).toBe(historicalPackage);
    },
  );
  it('handles missing actor and empty retention results', () => {
    expect(
      matchAudit([{ ...event, initiatedBy: {} }], 'group', 'member')?.actor,
    ).toBe('Unknown actor');
    expect(matchAudit([], 'group', 'member')).toBeNull();
  });
});
