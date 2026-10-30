import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  groupAssignments,
  formatDate,
  formatExpiration,
  formatRequestor,
  pendingRequestsForUser,
} from '../src/shared/accessPackages';
import type { AssignmentRequest } from '../src/shared/types';
import { loadUserAccessPackages } from '../src/background/accessPackages';
import { createGraphClient } from '../src/shared/graph';
import { json, mockChrome } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('assignment presentation helpers', () => {
  it('selects pending requests by recipient rather than requestor, without mutating input', () => {
    const requests: AssignmentRequest[] = [
      {
        id: 'on-behalf',
        state: 'pendingApproval',
        assignment: { target: { objectId: 'USER' } },
        requestor: { objectId: 'admin' },
      },
      {
        id: 'other-recipient',
        state: 'pendingApproval',
        assignment: { target: { objectId: 'other' } },
        requestor: { objectId: 'user' },
      },
      ...['delivered', 'denied', 'canceled', 'unknownFutureValue'].map(
        (state) => ({
          id: state,
          state,
          assignment: { target: { objectId: 'user' } },
        }),
      ),
      { id: 'missing-assignment', state: 'pendingApproval' },
      { id: 'null-assignment', state: 'pendingApproval', assignment: null },
      {
        id: 'missing-target',
        state: 'pendingApproval',
        assignment: {},
      },
      {
        id: 'null-object-id',
        state: 'pendingApproval',
        assignment: { target: { objectId: null } },
      },
      {
        id: 'self',
        state: 'pendingApproval',
        assignment: { target: { objectId: 'user' } },
      },
    ];
    const before = structuredClone(requests);
    expect(pendingRequestsForUser(requests, 'user').map((r) => r.id)).toEqual([
      'on-behalf',
      'self',
    ]);
    expect(requests).toEqual(before);
    expect(pendingRequestsForUser([], 'user')).toEqual([]);
  });

  it('formats requestor names with explicit fallbacks for missing details', () => {
    expect(
      formatRequestor({
        displayName: 'Admin',
        principalName: 'admin@example.com',
        email: 'email@example.com',
        objectId: 'admin-id',
      }),
    ).toBe('Admin');
    expect(formatRequestor({ principalName: 'admin@example.com' })).toBe(
      'admin@example.com',
    );
    expect(
      formatRequestor({ displayName: '', email: 'email@example.com' }),
    ).toBe('email@example.com');
    expect(formatRequestor({ objectId: 'admin-id' })).toBe('admin-id');
    expect(formatRequestor({})).toBe('Not provided');
    expect(formatRequestor(null)).toBe('Not provided');
    expect(formatRequestor(undefined)).toBe('Not provided');
  });

  it('groups only delivered, partiallyDelivered and delivering as active, preserving order', () => {
    const assignments = [
      'delivered',
      'expired',
      'partiallyDelivered',
      'deliveryFailed',
      'delivering',
      'partiallyExpired',
      'expiredFailed',
      'unknownFutureState',
    ].map((state, index) => ({ id: String(index), state }));
    const before = structuredClone(assignments);
    const grouped = groupAssignments(assignments);
    expect(grouped.active.map((a) => a.state)).toEqual([
      'delivered',
      'partiallyDelivered',
      'delivering',
    ]);
    expect(grouped.inactive.map((a) => a.state)).toEqual([
      'expired',
      'deliveryFailed',
      'partiallyExpired',
      'expiredFailed',
      'unknownFutureState',
    ]);
    expect(assignments).toEqual(before);
    expect(groupAssignments([])).toEqual({ active: [], inactive: [] });
  });

  it('formats UTC dates consistently and reports missing/invalid dates explicitly', () => {
    expect(formatDate('2026-10-29T18:00:00+02:00')).toBe(
      '2026-10-29T16:00:00.000Z',
    );
    expect(formatDate('bad date')).toBe('Invalid date');
    expect(formatDate(null)).toBe('Not provided');
    expect(formatDate(undefined)).toBe('Not provided');
    expect(formatExpiration({ expiration: { type: 'noExpiration' } })).toBe(
      'No expiration',
    );
    expect(
      formatExpiration({ expiration: { endDateTime: '2026-10-29T16:00:00Z' } }),
    ).toBe('2026-10-29T16:00:00.000Z');
    expect(
      formatExpiration({
        startDateTime: '2026-10-01T00:00:00Z',
        expiration: { duration: 'P30D' },
      }),
    ).toBe('After P30D from 2026-10-01T00:00:00.000Z');
    expect(formatExpiration(undefined)).toBe('Not provided');
    expect(formatExpiration({ expiration: { type: 'afterDateTime' } })).toBe(
      'Not provided',
    );
  });
});

describe('user access package data', () => {
  it('paginates assignments and reuses feature 1 resources without fetching user profiles or filtering by state', async () => {
    const chrome = mockChrome();
    chrome.session.values.packageCache = {
      sessionId: 'session',
      expiresAt: Date.now() + 60_000,
      packages: [
        {
          id: 'PKG',
          displayName: 'Package',
          resourceRoleScopes: [
            {
              scope: {
                originId: 'group',
                originSystem: 'AadGroup',
                displayName: 'Group name',
              },
            },
            {
              scope: {
                originId: 'group',
                originSystem: 'AadGroup',
                displayName: 'Group name',
              },
            },
            {
              scope: {
                originId: 'app',
                originSystem: 'AadApplication',
                displayName: 'Application',
              },
            },
            { scope: {} },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/assignmentRequests')) {
        expect(url.searchParams.get('$filter')).toBe(
          "state eq 'pendingApproval'",
        );
        expect(url.searchParams.get('$expand')).toBe(
          'accessPackage,assignment($expand=target),requestor',
        );
        return json({
          value: [
            {
              id: 'other-user',
              state: 'pendingApproval',
              assignment: { target: { objectId: 'other' } },
              requestor: { objectId: 'user' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/request-next',
        });
      }
      if (url.pathname.endsWith('/request-next'))
        return json({
          value: [
            {
              id: 'pending',
              state: 'pendingApproval',
              createdDateTime: '2026-10-29T18:00:00+02:00',
              accessPackage: { id: 'pkg', displayName: 'Package' },
              assignment: { target: { objectId: 'USER' } },
              requestor: { displayName: 'Admin', objectId: 'admin' },
            },
            {
              id: 'denied',
              state: 'denied',
              assignment: { target: { objectId: 'user' } },
            },
          ],
        });
      if (url.pathname.endsWith('/assignments')) {
        expect(url.searchParams.get('$filter')).toBe(
          "target/objectId eq 'user'",
        );
        expect(url.searchParams.get('$expand')).toBe(
          'accessPackage($expand=catalog),assignmentPolicy,target',
        );
        return json({
          value: [
            {
              id: 'a1',
              state: 'delivered',
              target: { objectId: 'user', displayName: 'User name' },
              accessPackage: {
                id: 'pkg',
                displayName: 'Package',
                catalog: { displayName: 'Catalog' },
              },
              assignmentPolicy: { displayName: 'Policy' },
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/assignment-next',
        });
      }
      if (url.pathname.endsWith('/assignment-next'))
        return json({
          value: [
            {
              id: 'a2',
              state: 'expired',
              accessPackage: { id: 'deleted-package' },
            },
          ],
        });
      throw new Error(`Unexpected Graph call: ${url.href}`);
    });
    const data = await loadUserAccessPackages(
      'user',
      createGraphClient(async () => 'token', fetcher),
      'session',
      new AbortController().signal,
    );
    expect(data.displayName).toBe('User name');
    expect(data.assignments).toHaveLength(2);
    expect(data.assignments[0]).toMatchObject({
      assignmentPolicy: { displayName: 'Policy' },
      accessPackage: { catalog: { displayName: 'Catalog' } },
      resources: [
        { id: 'group', name: 'Group name', system: 'AadGroup' },
        { id: 'app', name: 'Application', system: 'AadApplication' },
      ],
    });
    expect(data.assignments[1]?.resources).toEqual([]);
    expect(data.pendingRequests).toHaveLength(1);
    expect(data.pendingRequests[0]).toMatchObject({
      id: 'pending',
      accessPackage: { id: 'pkg', displayName: 'Package' },
    });
    expect(formatDate(data.pendingRequests[0]?.createdDateTime)).toBe(
      '2026-10-29T16:00:00.000Z',
    );
    expect(formatRequestor(data.pendingRequests[0]?.requestor)).toBe('Admin');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('uses the existing paged package loader on a cold cache and handles no assignments', async () => {
    const chrome = mockChrome();
    chrome.session.values.auth = { sessionId: 'session' };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accessPackages'))
        return json({
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/package-next',
        });
      if (url.pathname.endsWith('/package-next'))
        return json({
          value: [
            {
              id: 'pkg',
              displayName: 'Package',
              'resourceRoleScopes@odata.nextLink':
                'https://graph.microsoft.com/v1.0/expanded-next',
            },
          ],
        });
      if (url.pathname.endsWith('/resourceRoleScopes'))
        return json({
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/scope-next',
        });
      if (url.pathname.endsWith('/scope-next'))
        return json({
          value: [{ scope: { originId: 'g', originSystem: 'AadGroup' } }],
        });
      if (url.pathname.endsWith('/assignments')) return json({ value: [] });
      if (url.pathname.endsWith('/assignmentRequests'))
        return json({ value: [] });
      throw new Error(`Unexpected Graph call: ${url.href}`);
    });
    const data = await loadUserAccessPackages(
      'user',
      createGraphClient(async () => 'token', fetcher),
      'session',
      new AbortController().signal,
    );
    expect(data).toEqual({
      userId: 'user',
      displayName: 'user',
      assignments: [],
      pendingRequests: [],
    });
    expect(chrome.session.values.packageCache).toMatchObject({
      sessionId: 'session',
      packages: [{ resourceRoleScopes: [{ scope: { originId: 'g' } }] }],
    });
  });

  it('uses the recipient name for a pending-only user, not the requestor name', async () => {
    const chrome = mockChrome();
    chrome.session.values.packageCache = {
      sessionId: 'session',
      expiresAt: Date.now() + 60_000,
      packages: [],
    };
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname.endsWith('/assignmentRequests')
        ? json({
            value: [
              {
                id: 'pending',
                state: 'pendingApproval',
                assignment: {
                  target: { objectId: 'user', displayName: 'Recipient' },
                },
                requestor: { displayName: 'Admin' },
              },
            ],
          })
        : json({ value: [] }),
    );
    const data = await loadUserAccessPackages(
      'user',
      createGraphClient(async () => 'token', fetcher),
      'session',
      new AbortController().signal,
    );
    expect(data.displayName).toBe('Recipient');
    expect(data.assignments).toEqual([]);
    expect(data.pendingRequests.map((r) => r.id)).toEqual(['pending']);
  });

  it.each([
    [400, false],
    [403, false],
    [400, true],
    [403, true],
  ] as const)(
    'preserves assignments and surfaces request failures (status %s, first page %s)',
    async (status, firstPage) => {
      const chrome = mockChrome();
      chrome.session.values.packageCache = {
        sessionId: 'session',
        expiresAt: Date.now() + 60_000,
        packages: [],
      };
      const fetcher = vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/assignments'))
          return json({
            value: [
              {
                id: 'assignment',
                state: 'delivered',
                target: { objectId: 'user', displayName: 'Recipient' },
              },
            ],
          });
        if (path.endsWith('/assignmentRequests')) {
          if (firstPage) return json({ error: { code: 'Denied' } }, status);
          return json({
            value: [
              {
                id: 'partial',
                state: 'pendingApproval',
                assignment: { target: { objectId: 'user' } },
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/request-next',
          });
        }
        if (path.endsWith('/request-next'))
          return json({ error: { code: 'Denied' } }, status);
        throw new Error(`Unexpected Graph call: ${path}`);
      });
      const data = await loadUserAccessPackages(
        'user',
        createGraphClient(async () => 'token', fetcher),
        'session',
        new AbortController().signal,
      );
      expect(data.displayName).toBe('Recipient');
      expect(data.assignments).toEqual([
        {
          id: 'assignment',
          state: 'delivered',
          target: { objectId: 'user', displayName: 'Recipient' },
          resources: [],
        },
      ]);
      expect(data.pendingRequests).toEqual([]);
      expect(data.pendingRequestsError).toContain(
        status === 403 ? 'EntitlementManagement.Read.All' : '400',
      );
      expect(fetcher).toHaveBeenCalledTimes(firstPage ? 2 : 3);
    },
  );

  it.each([401, 403])(
    'surfaces Graph %s rather than an empty success',
    async (status) => {
      mockChrome();
      const fetcher = vi.fn<typeof fetch>(async () =>
        json({ error: { code: 'Denied' } }, status),
      );
      await expect(
        loadUserAccessPackages(
          'user',
          createGraphClient(async () => 'token', fetcher),
          'session',
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        status === 401 ? 'Sign in again' : 'EntitlementManagement.Read.All',
      );
    },
  );
});
