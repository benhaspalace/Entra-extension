import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGraphClient } from '../src/shared/graph';
import { loadPackages } from '../src/shared/packages';
import { json, mockChrome } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared package loader', () => {
  it('uses the documented paged expansion and only refetches truncated role scopes', async () => {
    const chrome = mockChrome();
    chrome.session.values.auth = { sessionId: 'session' };
    const scope = {
      role: { originId: 'Member_g', displayName: 'Member' },
      scope: { originId: 'g', originSystem: 'AadGroup' },
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accessPackages')) {
        expect(url.searchParams.get('$expand')).toBe(
          'resourceRoleScopes($expand=role,scope)',
        );
        expect(url.searchParams.get('$select')).toBe('id,displayName');
        return json({
          value: [
            {
              id: 'complete',
              displayName: 'Complete',
              resourceRoleScopes: [scope],
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/packages-next',
        });
      }
      if (url.pathname.endsWith('/packages-next'))
        return json({
          value: [
            { id: 'empty', displayName: 'Empty', resourceRoleScopes: [] },
            { id: 'missing', displayName: 'Missing' },
            {
              id: 'truncated',
              displayName: 'Truncated',
              resourceRoleScopes: [],
              'resourceRoleScopes@odata.nextLink':
                'https://graph.microsoft.com/v1.0/expanded-next',
            },
          ],
        });
      if (url.pathname.endsWith('/truncated/resourceRoleScopes')) {
        expect(url.searchParams.get('$expand')).toBe('role,scope');
        return json({
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/scopes-next',
        });
      }
      if (url.pathname.endsWith('/scopes-next'))
        return json({ value: [scope] });
      throw new Error(`Unexpected Graph call: ${url.href}`);
    });
    const packages = await loadPackages(
      createGraphClient(async () => 't', fetcher),
      'session',
      new AbortController().signal,
    );
    expect(packages.map((pkg) => pkg.resourceRoleScopes)).toEqual([
      [scope],
      [],
      undefined,
      [scope],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(chrome.session.values.packageCache).toMatchObject({ packages });
  });

  it('returns fetched packages even when the session cache write fails', async () => {
    const chrome = mockChrome();
    chrome.session.values.auth = { sessionId: 'session' };
    chrome.session.set.mockRejectedValueOnce(new Error('Quota exceeded'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const packages = [
      { id: 'package', displayName: 'Package', resourceRoleScopes: [] },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ value: packages }));
    await expect(
      loadPackages(
        createGraphClient(async () => 't', fetcher),
        'session',
        new AbortController().signal,
      ),
    ).resolves.toEqual(packages);
    expect(warning).toHaveBeenCalledWith(
      'Access package cache could not be saved to session storage.',
    );
    expect(chrome.session.values.packageCache).toBeUndefined();
  });
});
