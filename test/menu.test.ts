// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://entra.microsoft.com/"}
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloneMenuItem,
  findAnchorItem,
  MENU_MARKER,
} from '../src/content/menu';
import { watchProfileMenu } from '../src/content/profileMenu';
import * as menu from '../src/content/menu';

const ID = '12345678-1234-4abc-8def-123456789abc';
const OTHER = '87654321-4321-4abc-8def-123456789abc';
const profile = (section = 'overview', id = ID) =>
  `/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/${section}/userId/${id}`;
let fixture: string;

function trustedEventDriver() {
  const listeners = vi.spyOn(EventTarget.prototype, 'addEventListener');
  return (item: HTMLElement, event: Event) => {
    const index = listeners.mock.calls.findIndex(
      ([type], index) =>
        type === event.type && listeners.mock.instances[index] === item,
    );
    const listener = listeners.mock.calls[index]?.[1];
    if (!listener) throw new Error('Missing menu event listener');
    // jsdom cannot generate trusted input; invoke the registered handler with it.
    const trusted = new Proxy(event, {
      get(target, key) {
        if (key === 'isTrusted') return true;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    if (typeof listener === 'function') listener.call(item, trusted);
    else listener.handleEvent(trusted);
  };
}

beforeEach(async () => {
  fixture = await readFile(
    join('test', 'fixtures', 'ibiza-user-menu.html'),
    'utf8',
  );
  document.body.innerHTML = fixture;
  history.replaceState(null, '', profile());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Ibiza resource menu helpers', () => {
  it('chooses the last visible anchor rather than hidden earlier or later blades', () => {
    const original = document.querySelector<HTMLElement>('#custom-item')!;
    const second = original.cloneNode(true) as HTMLElement;
    const hidden = original.cloneNode(true) as HTMLElement;
    original.after(second, hidden);
    vi.spyOn(original, 'getClientRects').mockReturnValue({
      length: 1,
    } as DOMRectList);
    vi.spyOn(second, 'getClientRects').mockReturnValue({
      length: 1,
    } as DOMRectList);
    expect(findAnchorItem(document.body)).toBe(second);
    vi.spyOn(original, 'getClientRects').mockReturnValue({
      length: 0,
    } as DOMRectList);
    expect(findAnchorItem(document.body)).toBe(second);
  });

  it('falls back to the last match only when document layout is unavailable', () => {
    const original = document.querySelector<HTMLElement>('#custom-item')!;
    const last = original.cloneNode(true) as HTMLElement;
    original.after(last);
    expect(findAnchorItem(document.body)).toBe(last);
    vi.spyOn(document.documentElement, 'getClientRects').mockReturnValue({
      length: 1,
    } as DOMRectList);
    expect(findAnchorItem(document.body)).toBeNull();
  });

  it('locates labels with a text-node TreeWalker', () => {
    const walker = vi.spyOn(document, 'createTreeWalker');
    expect(findAnchorItem(document.body)?.id).toBe('custom-item');
    expect(walker).toHaveBeenCalledWith(document.body, NodeFilter.SHOW_TEXT);
  });

  it('finds the exact trimmed label and climbs to its resource item', () => {
    const anchor = findAnchorItem(document.body);
    expect(anchor?.id).toBe('custom-item');
    expect(anchor?.tagName).toBe('LI');
    document.querySelector('#custom-label')!.textContent =
      'Custom security attributes extra';
    expect(findAnchorItem(document.body)).toBeNull();
    document.querySelector('#custom-label')!.textContent =
      'Attributs de sécurité personnalisés';
    expect(
      findAnchorItem(document.body, ['Attributs de sécurité personnalisés'])
        ?.id,
    ).toBe('custom-item');
  });

  it.each(['listitem', 'treeitem', 'menuitem'])(
    'supports %s containers and ignores its own clones',
    (role) => {
      document.body.innerHTML = `<div role="${role}"><span> Custom security attributes </span></div>`;
      const anchor = findAnchorItem(document.body);
      expect(anchor?.getAttribute('role')).toBe(role);
      anchor!.dataset.entraHelper = 'access-packages';
      expect(findAnchorItem(document.body)).toBeNull();
      document.body.innerHTML = '<div>Custom security attributes</div>';
      expect(findAnchorItem(document.body)).toBeNull();
    },
  );

  it('clones portal styling, replacing the label/icon and sanitising navigation and selection', () => {
    const anchor = findAnchorItem(document.body)!;
    const originalListener = vi.fn();
    anchor.addEventListener('click', originalListener);
    const clone = cloneMenuItem(anchor);
    expect(clone.matches(MENU_MARKER)).toBe(true);
    expect(clone.textContent?.trim()).toBe('Access packages');
    expect(clone.tabIndex).toBe(0);
    expect(clone.getAttribute('aria-label')).toBe('Access packages');
    expect(
      clone.classList.contains('fxs-blade-resource-navigation-list-item'),
    ).toBe(true);
    expect(
      clone.querySelector(
        '[id], [href], [onclick], [data-bind], [aria-controls], [aria-current]',
      ),
    ).toBeNull();
    expect(clone.hasAttribute('id')).toBe(false);
    expect(clone.hasAttribute('aria-selected')).toBe(false);
    expect(
      clone.querySelector(
        '[class*="selected"], [class*="active"], a, button, use',
      ),
    ).toBeNull();
    expect(clone.className).not.toContain('selected');
    expect(clone.querySelectorAll('svg')).toHaveLength(1);
    expect(clone.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    clone.click();
    expect(originalListener).not.toHaveBeenCalled();
    expect(anchor.id).toBe('custom-item');
    expect(anchor.querySelector('a')?.getAttribute('href')).toBe(
      '#custom-security-attributes',
    );
  });

  it('strips embedded active content and handles a label on the item itself', () => {
    const anchor = document.createElement('li');
    anchor.textContent = 'Custom security attributes';
    anchor.insertAdjacentHTML(
      'beforeend',
      '<script>bad()</script><iframe src="https://example.com"></iframe><img src="x" onerror="bad()">',
    );
    const clone = cloneMenuItem(anchor);
    expect(clone.textContent).toBe('Access packages');
    expect(clone.querySelector('script, iframe, img')).toBeNull();
  });
});

describe('profile menu lifecycle', () => {
  it('inserts directly above the anchor, survives rerenders without duplicates, and cleans up on navigation', async () => {
    vi.useFakeTimers();
    const watcher = watchProfileMenu();
    watcher.update();
    const item = document.querySelector(MENU_MARKER);
    expect(item?.nextElementSibling?.id).toBe('custom-item');
    watcher.update();
    expect(document.querySelectorAll(MENU_MARKER)).toHaveLength(1);
    document.querySelector('nav')!.outerHTML = fixture;
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelectorAll(MENU_MARKER)).toHaveLength(1);
    expect(document.querySelector(MENU_MARKER)?.nextElementSibling?.id).toBe(
      'custom-item',
    );
    history.replaceState(null, '', profile('Groups'));
    watcher.update();
    expect(document.querySelectorAll(MENU_MARKER)).toHaveLength(1);
    history.replaceState(
      null,
      '',
      '/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Members/groupId/' + ID,
    );
    watcher.update();
    expect(document.querySelector(MENU_MARKER)).toBeNull();
    document.body.innerHTML = fixture;
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(MENU_MARKER)).toBeNull();
    watcher.dispose();
  });

  it('waits for a late anchor and removes the item if the menu vanishes', async () => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    const watcher = watchProfileMenu();
    watcher.update();
    expect(document.querySelector(MENU_MARKER)).toBeNull();
    document.body.innerHTML = fixture;
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelectorAll(MENU_MARKER)).toHaveLength(1);
    document.querySelector('#custom-item')!.remove();
    await vi.advanceTimersByTimeAsync(300);
    expect(document.querySelector(MENU_MARKER)).toBeNull();
    watcher.dispose();
  });

  it('throttles continuous child mutations without debounce starvation or characterData observation', async () => {
    vi.useFakeTimers();
    const find = vi.spyOn(menu, 'findAnchorItem');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const watcher = watchProfileMenu();
    watcher.update();
    expect(observe).toHaveBeenCalledWith(document.body, {
      childList: true,
      subtree: true,
    });
    expect(find).toHaveBeenCalledTimes(1);
    document.querySelector(MENU_MARKER)!.remove();
    for (let index = 0; index < 4; index++) {
      document.body.append(document.createElement('div'));
      await vi.advanceTimersByTimeAsync(50);
      expect(find).toHaveBeenCalledTimes(1);
    }
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(50);
    expect(find).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll(MENU_MARKER)).toHaveLength(1);
    for (let index = 0; index < 5; index++) {
      document.body.append(document.createElement('div'));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(find).toHaveBeenCalledTimes(3);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(find).toHaveBeenCalledTimes(3);
  });

  it.each([
    new MouseEvent('click', { bubbles: true, cancelable: true }),
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
    new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
  ])('ignores untrusted $type events', (event) => {
    const attachShadow = vi.spyOn(Element.prototype, 'attachShadow');
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const watcher = watchProfileMenu();
    watcher.update();
    document.querySelector(MENU_MARKER)!.dispatchEvent(event);
    expect(event.isTrusted).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(attachShadow).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it.each(['Enter', ' '])(
    'activates with %s and closes the drawer when changing users',
    (key) => {
      const dispatchTrusted = trustedEventDriver();
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn(async () => ({
            ok: false,
            error: 'Sign in again.',
          })),
        },
      });
      const attachShadow = vi.spyOn(Element.prototype, 'attachShadow');
      const watcher = watchProfileMenu();
      watcher.update();
      const item = document.querySelector<HTMLElement>(MENU_MARKER)!;
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      dispatchTrusted(item, event);
      expect(event.defaultPrevented).toBe(true);
      expect(attachShadow).toHaveBeenCalledWith({ mode: 'closed' });
      const host = attachShadow.mock.instances[0] as HTMLElement;
      expect(host.isConnected).toBe(true);
      expect(host.shadowRoot).toBeNull();
      history.replaceState(null, '', profile('overview', OTHER));
      watcher.update();
      expect(host.isConnected).toBe(false);
      expect(document.querySelectorAll(MENU_MARKER)).toHaveLength(1);
      watcher.dispose();
    },
  );

  it('opens only one drawer on repeated clicks without invoking portal navigation', () => {
    const dispatchTrusted = trustedEventDriver();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(async () => ({
          ok: false,
          error: 'Sign in again.',
        })),
      },
    });
    const attachShadow = vi.spyOn(Element.prototype, 'attachShadow');
    const portalClick = vi.fn();
    document.querySelector('nav')!.addEventListener('click', portalClick);
    const watcher = watchProfileMenu();
    watcher.update();
    const item = document.querySelector<HTMLElement>(MENU_MARKER)!;
    dispatchTrusted(item, new MouseEvent('click', { cancelable: true }));
    const first = attachShadow.mock.instances[0] as HTMLElement;
    expect(first.isConnected).toBe(true);
    dispatchTrusted(item, new MouseEvent('click', { cancelable: true }));
    const second = attachShadow.mock.instances[1] as HTMLElement;
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
    expect(portalClick).not.toHaveBeenCalled();
    history.replaceState(null, '', '/#home');
    watcher.update();
    expect(second.isConnected).toBe(false);
    expect(document.querySelector(MENU_MARKER)).toBeNull();
    watcher.dispose();
  });

  it('preserves feature 1 hash/history/polling notifications', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const sendMessage = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await import('../src/content/index');
    expect(sendMessage).toHaveBeenCalledWith({ type: 'contextChanged' });
    history.replaceState(null, '', profile('Groups'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    history.replaceState(null, '', profile('overview', OTHER));
    window.dispatchEvent(new PopStateEvent('popstate'));
    history.replaceState(null, '', '/#home');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(document.querySelector(MENU_MARKER)).toBeNull();
    vi.clearAllTimers();
  });
});
