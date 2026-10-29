import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, mockChrome, settings } from './helpers';

const tokenBody = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  token_type: 'Bearer',
  expires_in: 3600,
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('background PKCE sign-in and session isolation', () => {
  it('redeems a PKCE code without a secret and persists tokens in session only', async () => {
    const chrome = mockChrome();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(tokenBody));
    vi.stubGlobal('fetch', fetcher);
    const auth = await import('../src/background/auth');
    expect(await auth.authStatus()).toEqual({
      signedIn: false,
      sessionId: null,
    });
    const signedIn = await auth.signIn();
    expect(signedIn.signedIn).toBe(true);
    const authorize = new URL(
      chrome.launchWebAuthFlow.mock.calls[0]?.[0].url ?? '',
    );
    expect(authorize.origin).toBe('https://login.microsoftonline.com');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://extension.chromiumapp.org/',
    );
    const params = fetcher.mock.calls[0]?.[1]?.body;
    expect(params).toBeInstanceOf(URLSearchParams);
    if (!(params instanceof URLSearchParams))
      throw new Error('Missing token parameters');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code_verifier')).toHaveLength(43);
    expect(params.has('client_secret')).toBe(false);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/token`,
    );
    expect(chrome.session.values.auth).toMatchObject({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      sessionId: signedIn.sessionId,
    });
    expect(chrome.sync.set).not.toHaveBeenCalled();
    expect(chrome.local.set).not.toHaveBeenCalled();
    expect(await auth.getToken(false)).toBe('test-access-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await auth.authStatus()).toEqual(signedIn);
  });

  it('refreshes with a rotated refresh token and deduplicates concurrent refreshes', async () => {
    const chrome = mockChrome();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(tokenBody))
      .mockResolvedValueOnce(
        json({
          ...tokenBody,
          access_token: 'new-access',
          refresh_token: 'new-refresh',
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const auth = await import('../src/background/auth');
    const first = await auth.signIn();
    expect(
      await Promise.all([auth.getToken(true), auth.getToken(true)]),
    ).toEqual(['new-access', 'new-access']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const params = fetcher.mock.calls[1]?.[1]?.body;
    expect(
      params instanceof URLSearchParams && params.get('refresh_token'),
    ).toBe('test-refresh-token');
    expect(chrome.session.values.auth).toMatchObject({
      refreshToken: 'new-refresh',
      sessionId: first.sessionId,
    });
  });

  it('rejects state mismatch and never attempts token redemption', async () => {
    const chrome = mockChrome();
    chrome.launchWebAuthFlow.mockResolvedValue(
      'https://extension.chromiumapp.org/?state=wrong&code=code',
    );
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const auth = await import('../src/background/auth');
    await expect(auth.signIn()).rejects.toThrow('state');
    expect(fetcher).not.toHaveBeenCalled();
    expect(chrome.session.set).not.toHaveBeenCalled();
  });

  it('clears tokens/cache on sign-out and invalid refresh grants', async () => {
    const chrome = mockChrome();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(tokenBody))
      .mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    vi.stubGlobal('fetch', fetcher);
    const auth = await import('../src/background/auth');
    await auth.signIn();
    chrome.session.values.packageCache = { privateData: 'package' };
    await expect(auth.getToken(true)).rejects.toThrow('Sign in again');
    expect(chrome.session.values).toEqual({});
    expect(await auth.signOut()).toEqual({ signedIn: false, sessionId: null });
  });

  it('does not persist token responses after a concurrent sign-out', async () => {
    const chrome = mockChrome();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const auth = await import('../src/background/auth');
    const signingIn = auth.signIn();
    const rejection = expect(signingIn).rejects.toThrow('state changed');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await auth.signOut();
    resolveFetch?.(json(tokenBody));
    await rejection;
    expect(chrome.session.values).toEqual({});
  });

  it('removes tokens if sign-out races with an in-flight storage write', async () => {
    const chrome = mockChrome();
    const write = chrome.session.set.getMockImplementation();
    if (!write) throw new Error('Missing storage mock');
    let finishWrite: (() => void) | undefined;
    chrome.session.set.mockImplementation(
      (items) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            void write(items).then(resolve);
          };
        }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(json(tokenBody)),
    );
    const auth = await import('../src/background/auth');
    const signingIn = auth.signIn();
    const rejection = expect(signingIn).rejects.toThrow('state changed');
    await vi.waitFor(() => expect(chrome.session.set).toHaveBeenCalled());
    await auth.signOut();
    finishWrite?.();
    await rejection;
    expect(chrome.session.values).toEqual({});
  });

  it('rejects a changed tenant/client and never fetches tokens for injected settings', async () => {
    const chrome = mockChrome();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(json(tokenBody)),
    );
    const auth = await import('../src/background/auth');
    await auth.signIn();
    chrome.sync.values.settings = { ...settings, auditEnabled: false };
    expect((await auth.authStatus()).signedIn).toBe(false);
    await expect(auth.getToken(false)).rejects.toThrow('Sign in');
    chrome.sync.values.settings = { ...settings, tenantId: '../common' };
    await expect(auth.signIn()).rejects.toThrow('Configure');
  });
});
