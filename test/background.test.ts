import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
