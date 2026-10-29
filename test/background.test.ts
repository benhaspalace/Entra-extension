import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, mockChrome, settings } from './helpers';
import { settingsKey } from '../src/shared/settings';

afterEach(() => vi.unstubAllGlobals());

describe('background message trust boundary', () => {
  it('only serves auth requests to its own panel and options pages', async () => {
    vi.resetModules();
    const listeners: ((
      message: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (response: unknown) => void,
    ) => unknown)[] = [];
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'extension',
        getURL: (path: string) => `chrome-extension://extension/${path}`,
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) =>
            listeners.push(listener),
        },
      },
      tabs: { onUpdated: { addListener: vi.fn() } },
      storage: { session: { get: vi.fn(async () => ({})) } },
    });
    await import('../src/background/index');
    const listener = listeners[0];
    if (!listener) throw new Error('Missing message listener');
    const respond = vi.fn();
    for (const sender of [
      { id: 'extension', url: 'https://entra.microsoft.com/' },
      {
        id: 'another-extension',
        url: 'chrome-extension://extension/sidepanel/index.html',
      },
      { id: 'extension', url: 'chrome-extension://extension/content.js' },
      {
        id: 'extension',
        url: 'chrome-extension://extension/options/index.html?untrusted',
      },
    ]) {
      expect(listener({ type: 'authStatus' }, sender, respond)).toBeUndefined();
    }
    expect(respond).not.toHaveBeenCalled();
    for (const page of ['sidepanel', 'options']) {
      expect(
        listener(
          { type: 'authStatus' },
          {
            id: 'extension',
            url: `chrome-extension://extension/${page}/index.html`,
          },
          respond,
        ),
      ).toBe(true);
    }
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      value: { signedIn: false, sessionId: null },
    });
  });

  const USER = '12345678-1234-4abc-8def-123456789abc';
  const profileUrl = `https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${USER}`;

  function profileSender(): chrome.runtime.MessageSender {
    return {
      id: 'extension',
      frameId: 0,
      url: profileUrl,
      tab: {
        id: 1,
        url: profileUrl,
        index: 0,
        windowId: 1,
        active: true,
        highlighted: true,
        pinned: false,
        incognito: false,
        selected: true,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
        frozen: false,
        lastAccessed: Date.now(),
      },
    };
  }

  async function setupContentRequests(signedIn = true) {
    vi.resetModules();
    const chromeMock = mockChrome();
    if (signedIn) {
      chromeMock.session.values.auth = {
        accessToken: 'secret-token',
        refreshToken: null,
        sessionId: 'session',
        settingsKey: settingsKey(settings),
        expiresAt: Date.now() + 120_000,
      };
    }
    chromeMock.session.values.packageCache = {
      sessionId: 'session',
      expiresAt: Date.now() + 60_000,
      packages: [],
    };
    const listeners: ((
      message: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (response: unknown) => void,
    ) => unknown)[] = [];
    const open = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        value: [
          {
            id: 'assignment',
            state: 'delivered',
            target: { objectId: USER, displayName: 'User' },
            accessPackage: { id: 'package', displayName: 'Package' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('chrome', {
      storage: { session: chromeMock.session, sync: chromeMock.sync },
      runtime: {
        id: 'extension',
        getURL: (path: string) => `chrome-extension://extension/${path}`,
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) =>
            listeners.push(listener),
        },
      },
      sidePanel: { open },
      tabs: { onUpdated: { addListener: vi.fn() } },
    });
    await import('../src/background/index');
    const listener = listeners[0];
    if (!listener) throw new Error('Missing message listener');
    return { listener, open, fetcher, session: chromeMock.session };
  }

  describe('content-script assignment requests', () => {
    it('only serves a top-frame Entra user profile and never permits auth or token requests', async () => {
      const { listener, fetcher } = await setupContentRequests();
      const respond = vi.fn();
      const sender = profileSender();
      for (const invalid of [
        { ...sender, frameId: 1 },
        { ...sender, id: 'another-extension' },
        { ...sender, url: 'https://evil.example/' },
        { id: 'extension', frameId: 0, url: profileUrl },
        {
          ...sender,
          tab: { ...sender.tab!, url: 'https://entra.microsoft.com/#home' },
        },
        {
          id: 'extension',
          url: 'chrome-extension://extension/sidepanel/index.html',
        },
      ]) {
        expect(
          listener(
            { type: 'getUserAccessPackages', payload: { userId: USER } },
            invalid,
            respond,
          ),
        ).toBeUndefined();
        expect(
          listener({ type: 'openSidePanel' }, invalid, respond),
        ).toBeUndefined();
      }
      for (const type of ['getToken', 'signIn', 'signOut', 'authStatus']) {
        expect(
          listener({ type, payload: { refresh: false } }, sender, respond),
        ).toBeUndefined();
      }
      expect(respond).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('validates the requested user against the tab URL before Graph', async () => {
      const { listener, fetcher } = await setupContentRequests();
      for (const payload of [
        undefined,
        null,
        {},
        { userId: 4 },
        { userId: "x' or true" },
        { userId: '87654321-4321-4abc-8def-123456789abc' },
      ]) {
        const respond = vi.fn();
        expect(
          listener(
            { type: 'getUserAccessPackages', payload },
            profileSender(),
            respond,
          ),
        ).toBe(true);
        await vi.waitFor(() =>
          expect(respond).toHaveBeenCalledWith({
            ok: false,
            error: 'Invalid user access package request.',
          }),
        );
      }
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('returns assignment data, not tokens, using background auth', async () => {
      const { listener, fetcher } = await setupContentRequests();
      const respond = vi.fn();
      listener(
        {
          type: 'getUserAccessPackages',
          payload: { userId: USER.toUpperCase() },
        },
        profileSender(),
        respond,
      );
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith({
          ok: true,
          value: {
            userId: USER,
            displayName: 'User',
            assignments: [
              {
                id: 'assignment',
                state: 'delivered',
                target: { objectId: USER, displayName: 'User' },
                accessPackage: { id: 'package', displayName: 'Package' },
                resources: [],
              },
            ],
          },
        }),
      );
      expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer secret-token',
      });
      expect(JSON.stringify(respond.mock.calls)).not.toContain('secret-token');
    });

    it('surfaces sign-in guidance without making Graph calls when signed out', async () => {
      const { listener, fetcher } = await setupContentRequests(false);
      const respond = vi.fn();
      listener(
        { type: 'getUserAccessPackages', payload: { userId: USER } },
        profileSender(),
        respond,
      );
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith({
          ok: false,
          error:
            'Set your tenant and client IDs in Options, then sign in using the side panel.',
        }),
      );
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('rejects results if the sign-in session changes during Graph work', async () => {
      const { listener, fetcher, session } = await setupContentRequests();
      fetcher.mockImplementation(async () => {
        delete session.values.auth;
        return json({ value: [] });
      });
      const respond = vi.fn();
      listener(
        { type: 'getUserAccessPackages', payload: { userId: USER } },
        profileSender(),
        respond,
      );
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith({
          ok: false,
          error: 'Sign-in state changed. Sign in again.',
        }),
      );
    });

    it('opens the side panel synchronously in the sender tab, and reports open failures', async () => {
      const { listener, open } = await setupContentRequests();
      const respond = vi.fn();
      listener({ type: 'openSidePanel' }, profileSender(), respond);
      expect(open).toHaveBeenCalledWith({ tabId: 1 });
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith({ ok: true, value: null }),
      );
      open.mockRejectedValueOnce(new Error('Side panel unavailable.'));
      listener({ type: 'openSidePanel' }, profileSender(), respond);
      await vi.waitFor(() =>
        expect(respond).toHaveBeenCalledWith({
          ok: false,
          error: 'Side panel unavailable.',
        }),
      );
    });
  });
});
