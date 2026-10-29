import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  groupAssignments,
  formatDate,
  formatExpiration,
} from '../src/shared/accessPackages';
import { loadUserAccessPackages } from '../src/background/accessPackages';
import { createGraphClient } from '../src/shared/graph';
import { json, mockChrome } from './helpers';

afterEach(() => vi.unstubAllGlobals());

describe('assignment presentation helpers', () => {
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
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    });
    expect(chrome.session.values.packageCache).toMatchObject({
      sessionId: 'session',
      packages: [{ resourceRoleScopes: [{ scope: { originId: 'g' } }] }],
    });
  });

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
