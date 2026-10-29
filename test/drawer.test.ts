// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDrawer } from '../src/content/drawer';
import type { UserAccessPackages } from '../src/shared/types';
import { memberLink, packageLink } from '../src/shared/links';

const ID = '12345678-1234-4abc-8def-123456789abc';
let shadow: ShadowRoot;
let host: Element;
let returnFocus: HTMLButtonElement;

beforeEach(() => {
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init,
  ) {
    shadow = attach.call(this, init);
    host = shadow.host;
    return shadow;
  });
  returnFocus = document.createElement('button');
  document.body.append(returnFocus);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function button(label: string): HTMLButtonElement {
  const node = [...shadow.querySelectorAll('button')].find(
    (item) => item.textContent === label,
  );
  if (!node) throw new Error(`Missing drawer button: ${label}`);
  return node;
}

function data(): UserAccessPackages {
  return {
    userId: ID,
    displayName: '<img src=x onerror=alert(1)> User',
    assignments: [
      {
        id: 'a',
        state: 'partiallyDelivered',
        accessPackage: {
          id: 'pkg',
          displayName: '<script>Package</script>',
          catalog: { displayName: 'Catalog' },
        },
        assignmentPolicy: { displayName: 'Policy' },
        schedule: {
          startDateTime: '2026-10-01T00:00:00Z',
          expiration: { type: 'noExpiration' },
        },
        resources: [
          { id: 'group', name: '<img src=x> Group', system: 'AadGroup' },
          { id: 'app', name: 'Application', system: 'AadApplication' },
        ],
      },
      {
        id: 'b',
        state: 'deliveryFailed',
        schedule: { expiration: { endDateTime: '2026-10-29T00:00:00Z' } },
        resources: [],
      },
    ],
  };
}

describe('closed-shadow access package drawer', () => {
  it('renders assignment details and safe links, handles buttons, and restores focus', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, value: data() }));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const drawer = openDrawer(ID, returnFocus);
    expect(host.shadowRoot).toBeNull();
    expect(shadow.activeElement).toBe(button('Close'));
    await vi.waitFor(() =>
      expect(shadow.querySelector('article')).not.toBeNull(),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'getUserAccessPackages',
      payload: { userId: ID },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(shadow.querySelector('h1')?.textContent).toBe(
      `Access packages \u2014 ${data().displayName}`,
    );
    expect(
      [...shadow.querySelectorAll('h2')].map((h) => h.textContent),
    ).toEqual(['Active', 'Expired / failed']);
    expect(shadow.querySelectorAll('article')).toHaveLength(2);
    expect(shadow.textContent).toContain('Catalog: Catalog');
    expect(shadow.textContent).toContain('Policy: Policy');
    expect(shadow.textContent).toContain('State: partiallyDelivered');
    expect(shadow.textContent).toContain('Start: 2026-10-01T00:00:00.000Z');
    expect(shadow.textContent).toContain('Expiry: No expiration');
    expect(shadow.textContent).toContain('Expiry: 2026-10-29T00:00:00.000Z');
    expect(shadow.querySelector('script, img')).toBeNull();
    const links = [...shadow.querySelectorAll('a')];
    expect(links.map((a) => a.href)).toEqual([
      packageLink('pkg'),
      memberLink('group', 'group'),
    ]);
    expect(
      links.every(
        (a) => a.rel === 'noopener noreferrer' && a.target === '_blank',
      ),
    ).toBe(true);
    button('Open in side panel').click();
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'openSidePanel',
      payload: undefined,
    });
    button('Refresh').click();
    await vi.waitFor(() => expect(button('Refresh').disabled).toBe(false));
    expect(sendMessage).toHaveBeenCalledTimes(3);
    button('Close').click();
    expect(host.isConnected).toBe(false);
    expect(document.activeElement).toBe(returnFocus);
    drawer.close();
  });

  it('shows the empty state and supports Escape', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: true,
          value: { ...data(), assignments: [] },
        })),
      },
    });
    openDrawer(ID, returnFocus);
    await vi.waitFor(() =>
      expect(shadow.textContent).toContain('No access package assignments'),
    );
    expect(shadow.querySelector('article')).toBeNull();
    button('Close').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(host.isConnected).toBe(false);
    expect(document.activeElement).toBe(returnFocus);
  });

  it.each([
    'Set your tenant and client IDs in Options, then sign in using the side panel.',
    'Your session expired. Sign in again.',
    'Missing permission or directory role: EntitlementManagement.Read.All.',
    'The extension background worker is unavailable.',
  ])('surfaces errors and permits retry: %s', async (error) => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error })
      .mockResolvedValue({ ok: true, value: { ...data(), assignments: [] } });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    openDrawer(ID, returnFocus);
    await vi.waitFor(() =>
      expect(shadow.querySelector('[role="alert"]')?.textContent).toBe(error),
    );
    expect(shadow.querySelector('article')).toBeNull();
    button('Refresh').click();
    await vi.waitFor(() =>
      expect(shadow.textContent).toContain('No access package assignments'),
    );
    expect(shadow.querySelector('[role="alert"]')).toBeNull();
  });

  it('surfaces side panel failures without navigating the portal', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { ...data(), assignments: [] },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Could not open side panel.',
      });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    openDrawer(ID, returnFocus);
    await vi.waitFor(() =>
      expect(shadow.textContent).toContain('No access package assignments'),
    );
    button('Open in side panel').click();
    await vi.waitFor(() =>
      expect(shadow.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not open side panel.',
      ),
    );
  });

  it('does not render a stale response after closing', async () => {
    let resolve: (value: unknown) => void = () => {
      throw new Error('Request not started');
    };
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        ),
      },
    });
    const drawer = openDrawer(ID, returnFocus);
    drawer.close();
    resolve({ ok: true, value: data() });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.isConnected).toBe(false);
    expect(shadow.querySelector('article')).toBeNull();
  });
});
