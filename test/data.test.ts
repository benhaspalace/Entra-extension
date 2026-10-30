import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMembership } from '../src/sidepanel/data';
import { mapLimited } from '../src/shared/packages';
import { createGraphClient } from '../src/shared/graph';
import { json, mockChrome } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('membership data orchestration', () => {
  it.each(['group', 'user'] as const)(
    'loads paged PIM and transitive relationships in the %s view without duplicating direct membership',
    async (kind) => {
      const chrome = mockChrome();
      chrome.session.values.packageCache = {
        sessionId: 'account',
        expiresAt: Date.now() + 60_000,
        packages: [],
      };
      const instance = (subject: string, accessId = 'member') => ({
        id: `schedule-${subject}`,
        groupId: kind === 'group' ? 'g' : subject,
        principalId: kind === 'group' ? subject : 'u',
        accessId,
        assignmentType: 'activated',
        startDateTime: '2020-01-01T00:00:00Z',
        endDateTime: null,
        principal: { id: subject, displayName: `Principal ${subject}` },
        group: { id: subject, displayName: `Group ${subject}` },
      });
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname;
        if (path.endsWith('/groups/g')) return json({ id: 'g' });
        if (path.endsWith('/users/u')) return json({ id: 'u' });
        if (
          path.endsWith('/members') ||
          path.endsWith('/memberOf/microsoft.graph.group')
        )
          return json({ value: [{ id: 'direct', displayName: 'Direct' }] });
        if (
          path.endsWith('/transitiveMembers') ||
          path.includes('/transitiveMemberOf/')
        ) {
          expect(init?.headers).toMatchObject({ ConsistencyLevel: 'eventual' });
          expect(url.searchParams.get('$count')).toBe('true');
          return json({
            value: [{ id: 'DIRECT' }],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/transitive-next',
          });
        }
        if (path.endsWith('/transitive-next')) {
          expect(init?.headers).toMatchObject({ ConsistencyLevel: 'eventual' });
          return json({ value: [{ id: 'nested' }] });
        }
        if (path.endsWith('ScheduleInstances')) {
          expect(url.searchParams.get('$filter')).toBe(
            kind === 'group' ? "groupId eq 'g'" : "principalId eq 'u'",
          );
          expect(url.searchParams.get('$expand')).toBe(
            kind === 'group' ? 'principal' : 'group',
          );
          const eligible = path.endsWith('/eligibilityScheduleInstances');
          return json({
            value: [],
            '@odata.nextLink': `https://graph.microsoft.com/v1.0/${eligible ? 'eligible' : 'active'}-next`,
          });
        }
        if (path.endsWith('/active-next'))
          return json({
            value: [
              instance('direct'),
              instance('nested'),
              instance('unconfirmed'),
            ],
          });
        if (path.endsWith('/eligible-next'))
          return json({
            value: [
              instance('eligible'),
              instance('ELIGIBLE'),
              instance('direct'),
              instance('nested'),
              instance('owner', 'owner'),
              { ...instance('expired'), endDateTime: '2020-01-02T00:00:00Z' },
              { ...instance('future'), startDateTime: '2099-01-01T00:00:00Z' },
            ],
          });
        if (path.endsWith('/assignments')) return json({ value: [] });
        throw new Error(`Unexpected URL: ${url.href}`);
      });
      const data = await loadMembership(
        { kind, id: kind === 'group' ? 'g' : 'u' },
        createGraphClient(async () => 'token', fetcher),
        'account',
        new AbortController().signal,
      );
      expect(
        data.rows.map((row) => [row.membership, row.governance.source]),
      ).toEqual([
        ['direct', 'pim'],
        ['nested', 'nested'],
        ['eligible', 'pim'],
      ]);
      expect(data.rows[0]?.eligibility).toHaveLength(1);
      expect(data.rows[1]?.eligibility).toHaveLength(1);
      expect(data.rows[2]?.governance).toMatchObject({
        source: 'pim',
        status: 'eligible',
        instances: [{ id: 'schedule-eligible' }, { id: 'schedule-ELIGIBLE' }],
      });
      expect(
        kind === 'group'
          ? data.rows[2]?.member.displayName
          : data.rows[2]?.group.displayName,
      ).toContain('eligible');
    },
  );

  it.each([
    [
      'assignmentScheduleInstances',
      'PrivilegedAssignmentSchedule.Read.AzureADGroup',
    ],
    [
      'eligibilityScheduleInstances',
      'PrivilegedEligibilitySchedule.Read.AzureADGroup',
    ],
    ['transitiveMembers', 'GroupMember.Read.All'],
  ])(
    'surfaces %s failures instead of returning incomplete classifications',
    async (endpoint, scope) => {
      const chrome = mockChrome();
      chrome.session.values.packageCache = {
        sessionId: 'account',
        expiresAt: Date.now() + 60_000,
        packages: [],
      };
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith(`/${endpoint}`))
          return json({ error: { code: 'Forbidden' } }, 403);
        return url.pathname.endsWith('/groups/g')
          ? json({ id: 'g' })
          : json({ value: [] });
      });
      await expect(
        loadMembership(
          { kind: 'group', id: 'g' },
          createGraphClient(async () => 't', fetcher),
          'account',
          new AbortController().signal,
        ),
      ).rejects.toThrow(scope);
    },
  );

  it('paginates packages, role scopes, members and assignments in Group > Members', async () => {
    const chrome = mockChrome();
    chrome.session.values.auth = { sessionId: 'account' };
    const fetched: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      fetched.push(url.href);
      const path = url.pathname;
      if (
        path.endsWith('/transitiveMembers') ||
        path.endsWith('ScheduleInstances')
      )
        return json({ value: [] });
      if (path.endsWith('/accessPackages')) {
        return json({
          value: [
            {
              id: 'p1',
              displayName: 'First package',
              'resourceRoleScopes@odata.nextLink':
                'https://graph.microsoft.com/v1.0/expanded-next',
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/packages-next',
        });
      }
      if (path.endsWith('/packages-next'))
        return json({
          value: [
            {
              id: 'p2',
              displayName: 'Second package',
              'resourceRoleScopes@odata.nextLink':
                'https://graph.microsoft.com/v1.0/expanded-next',
            },
          ],
        });
      if (path.includes('/resourceRoleScopes')) {
        expect(url.searchParams.get('$expand')).toBe('role,scope');
        return json({
          value: [],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/scopes-next?package=${path.split('/')[5]}`,
        });
      }
      if (path.endsWith('/scopes-next'))
        return json({
          value: [
            {
              role: { displayName: 'Member' },
              scope: { originId: 'g', originSystem: 'AadGroup' },
            },
          ],
        });
      if (path.endsWith('/groups/g'))
        return json({ id: 'g', displayName: 'Group', groupTypes: [] });
      if (path.endsWith('/members'))
        return json({
          value: [{ id: 'u1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/members-next',
        });
      if (path.endsWith('/members-next'))
        return json({ value: [{ id: 'u2' }] });
      if (path.endsWith('/assignments')) {
        expect(url.searchParams.get('$filter')).toMatch(
          /^(accessPackage\/id|target\/objectId) eq '[^']+'$/,
        );
        const pkg = url.searchParams.get('$filter')?.includes("'p1'")
          ? 'p1'
          : 'p2';
        return json({
          value: [],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/assignments-next?package=${pkg}`,
        });
      }
      if (path.endsWith('/assignments-next'))
        return json({
          value: [
            {
              id: `a-${url.searchParams.get('package')}`,
              state:
                url.searchParams.get('package') === 'p1'
                  ? 'partiallyDelivered'
                  : 'delivering',
              target: { objectId: 'u1' },
            },
          ],
        });
      throw new Error(`Unexpected test URL: ${url.href}`);
    });
    const data = await loadMembership(
      { kind: 'group', id: 'g' },
      createGraphClient(async () => 'token', fetcher),
      'account',
      new AbortController().signal,
    );
    expect(data.title).toBe('Group - Members');
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]?.governance).toMatchObject({
      source: 'access-package',
      packages: [{ id: 'p1' }, { id: 'p2' }],
    });
    expect(data.rows[1]?.governance.source).toBe('manual');
    expect(fetched.filter((url) => url.includes('scopes-next'))).toHaveLength(
      2,
    );
    expect(fetched.some((url) => url.includes('/auditLogs/'))).toBe(false);
    expect(chrome.session.values.packageCache).toMatchObject({
      sessionId: 'account',
    });
  });

  it('uses the account-specific cache and classifies all groups in User > Groups', async () => {
    const chrome = mockChrome();
    chrome.session.values.packageCache = {
      sessionId: 'account',
      expiresAt: Date.now() + 60_000,
      packages: [
        {
          id: 'p1',
          displayName: 'Package 1',
          resourceRoleScopes: [
            {
              role: { displayName: 'Member' },
              scope: { originId: 'package-group', originSystem: 'AadGroup' },
            },
          ],
        },
        {
          id: 'p2',
          displayName: 'Package 2',
          resourceRoleScopes: [
            {
              role: { originId: 'Member_package-group' },
              scope: { originId: 'package-group', originSystem: 'AadGroup' },
            },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (
        url.pathname.includes('/transitiveMemberOf/') ||
        url.pathname.endsWith('ScheduleInstances')
      )
        return json({ value: [] });
      if (url.pathname.endsWith('/users/user')) {
        expect(url.searchParams.get('$select')).toBe(
          'displayName,userPrincipalName',
        );
        return json({
          displayName: 'User name',
          userPrincipalName: 'user@example.com',
        });
      }
      if (url.pathname.endsWith('/memberOf/microsoft.graph.group'))
        return json({
          value: [
            { id: 'package-group' },
            {
              id: 'dynamic',
              groupTypes: ['DynamicMembership'],
              membershipRule: 'rule',
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups-next',
        });
      if (url.pathname.endsWith('/groups-next'))
        return json({
          value: [
            { id: 'synced', onPremisesSyncEnabled: true },
            { id: 'manual' },
          ],
        });
      if (url.pathname.endsWith('/assignments')) {
        expect(url.searchParams.get('$filter')).toContain(
          "target/objectId eq 'user'",
        );
        expect(url.searchParams.get('$filter')).toMatch(
          /^(accessPackage\/id|target\/objectId) eq '[^']+'$/,
        );
        return json({
          value: [
            {
              id: 'a1',
              state: 'partiallyDelivered',
              accessPackage: { id: 'p1' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/assignment-next',
        });
      }
      if (url.pathname.endsWith('/assignment-next'))
        return json({
          value: [
            { id: 'a2', state: 'delivering', accessPackage: { id: 'p2' } },
          ],
        });
      throw new Error(`Unexpected test URL: ${url.href}`);
    });
    const data = await loadMembership(
      { kind: 'user', id: 'user' },
      createGraphClient(async () => 'token', fetcher),
      'account',
      new AbortController().signal,
    );
    expect(data.title).toBe('User name - Groups');
    expect(data.rows[0]?.member).toMatchObject({
      id: 'user',
      displayName: 'User name',
      userPrincipalName: 'user@example.com',
    });
    expect(data.rows.map((row) => row.governance.source)).toEqual([
      'access-package',
      'dynamic',
      'synced',
      'manual',
    ]);
    expect(data.rows[0]?.governance).toMatchObject({
      packages: [{ id: 'p1' }, { id: 'p2' }],
    });
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes('/accessPackages'),
      ),
    ).toBe(false);
  });

  it('falls back to the user id when the profile read is forbidden', async () => {
    const chrome = mockChrome();
    chrome.session.values.packageCache = {
      sessionId: 'account',
      expiresAt: Date.now() + 60_000,
      packages: [],
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (
        url.pathname.includes('/transitiveMemberOf/') ||
        url.pathname.endsWith('ScheduleInstances')
      )
        return json({ value: [] });
      if (url.pathname.endsWith('/users/user'))
        return json({ error: { code: 'Authorization_RequestDenied' } }, 403);
      if (url.pathname.endsWith('/memberOf/microsoft.graph.group'))
        return json({ value: [{ id: 'manual' }] });
      if (url.pathname.endsWith('/assignments')) return json({ value: [] });
      throw new Error(`Unexpected test URL: ${url.href}`);
    });
    const data = await loadMembership(
      { kind: 'user', id: 'user' },
      createGraphClient(async () => 'token', fetcher),
      'account',
      new AbortController().signal,
    );
    expect(data.title).toBe('user - Groups');
    expect(data.rows.map((row) => row.governance.source)).toEqual(['manual']);
  });

  it.each([
    ['other-account', Date.now() + 60_000],
    ['account', 0],
  ])(
    'does not reuse a cache for %s with expiry %s',
    async (sessionId, expiresAt) => {
      const chrome = mockChrome();
      chrome.session.values.packageCache = {
        sessionId,
        expiresAt,
        packages: [],
      };
      const fetcher = vi.fn<typeof fetch>(async (input) =>
        String(input).includes('/groups/g?')
          ? json({ id: 'g' })
          : json({ value: [] }),
      );
      await loadMembership(
        { kind: 'group', id: 'g' },
        createGraphClient(async () => 'token', fetcher),
        'account',
        new AbortController().signal,
      );
      expect(
        fetcher.mock.calls.some(([url]) =>
          String(url).includes('/accessPackages'),
        ),
      ).toBe(true);
      expect(chrome.session.set).not.toHaveBeenCalled();
    },
  );

  it('surfaces entitlement permission failures rather than mislabelling members manual', async () => {
    mockChrome();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { code: 'Forbidden' } }, 403));
    await expect(
      loadMembership(
        { kind: 'group', id: 'g' },
        createGraphClient(async () => 'token', fetcher),
        'account',
        new AbortController().signal,
      ),
    ).rejects.toThrow('EntitlementManagement.Read.All');
  });
});

describe('bounded concurrency', () => {
  it('limits requests to four, preserving input order', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimited(
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      4,
      async (value) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return value * 2;
      },
    );
    expect(peak).toBe(4);
    expect(result).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
  });
  it('supports empty input and rejects invalid limits and failed operations', async () => {
    expect(await mapLimited([], 4, async (value) => value)).toEqual([]);
    await expect(mapLimited([1], 0, async (value) => value)).rejects.toThrow(
      'positive integer',
    );
    await expect(
      mapLimited([1], 4, async () => {
        throw new Error('Failure');
      }),
    ).rejects.toThrow('Failure');
  });
});
