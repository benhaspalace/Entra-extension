// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, settings, storageArea } from './helpers';

const GROUP = '12345678-1234-4abc-8def-123456789abc';
const OTHER = '87654321-4321-4abc-8def-123456789abc';
const groupUrl = (id = GROUP) =>
  `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Members/groupId/${id}`;

class TestObserver {
  static instances: TestObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    readonly callback: (
      entries: { isIntersecting: boolean; target: Element }[],
    ) => void,
  ) {
    TestObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
}

beforeEach(() => {
  vi.resetModules();
  TestObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', TestObserver);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function setupPanel(
  signedIn = true,
  auditEnabled = true,
  extended = false,
) {
  await loadPage('sidepanel');
  const session = storageArea({
    auth: { sessionId: 'session' },
    packageCache: {
      sessionId: 'session',
      expiresAt: Date.now() + 60_000,
      packages: ['p1', 'p2'].map((id) => ({
        id,
        displayName: `${id}<img src=x onerror=alert(1)>`,
        resourceRoleScopes: [
          {
            role: { displayName: 'Member' },
            scope: { originId: GROUP, originSystem: 'AadGroup' },
          },
        ],
      })),
    },
  });
  const sync = storageArea({ settings: { ...settings, auditEnabled } });
  const tab = { id: 1, url: groupUrl() };
  const tabListeners: (() => void)[] = [];
  const sendMessage = vi.fn(async ({ type }: { type: string }) => {
    if (type === 'signIn') signedIn = true;
    if (type === 'signOut') signedIn = false;
    return {
      ok: true,
      value:
        type === 'getToken'
          ? 'test-token'
          : { signedIn, sessionId: signedIn ? 'session' : null },
    };
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension',
      sendMessage,
      openOptionsPage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
    storage: { session, sync, onChanged: { addListener: vi.fn() } },
    tabs: {
      query: vi.fn(async () => [tab]),
      onActivated: {
        addListener: (listener: () => void) => tabListeners.push(listener),
      },
      onUpdated: { addListener: vi.fn() },
    },
  });
  let auditStatus = 200;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (extended && url.pathname.endsWith('/transitiveMembers'))
      return json({
        value: [
          { id: 'packaged-user' },
          { id: 'nested', displayName: '<img src=x onerror=alert(1)>' },
        ],
      });
    if (extended && url.pathname.endsWith('ScheduleInstances')) {
      const eligible = url.pathname.endsWith('/eligibilityScheduleInstances');
      const principalId = eligible ? 'eligible' : 'manual-7';
      return json({
        value: [
          {
            id: 'pim-schedule',
            groupId: GROUP,
            principalId,
            accessId: 'member',
            assignmentType: 'activated',
            startDateTime: '2020-01-01T00:00:00Z',
            endDateTime: null,
            principal: { id: principalId, displayName: 'Eligible principal' },
          },
        ],
      });
    }
    if (
      url.pathname.endsWith('/transitiveMembers') ||
      url.pathname.endsWith('ScheduleInstances')
    )
      return json({ value: [] });
    if (url.pathname.endsWith(`/groups/${GROUP}`))
      return json({ id: GROUP, displayName: 'Test group' });
    if (url.pathname.endsWith(`/groups/${OTHER}`))
      return json({
        id: OTHER,
        displayName: 'Other group',
        groupTypes: ['DynamicMembership'],
        membershipRule: 'test rule',
      });
    if (url.pathname.endsWith('/members'))
      return json({
        value: [
          { id: 'packaged-user', displayName: '<script>unsafe</script>' },
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `manual-${index}`,
            displayName: `Manual ${index}`,
          })),
        ],
      });
    if (url.pathname.endsWith('/assignments'))
      return json({
        value: [
          {
            id: 'assignment',
            state: 'delivered',
            target: { objectId: 'packaged-user' },
          },
        ],
      });
    if (url.pathname.endsWith('/directoryAudits')) {
      if (auditStatus !== 200)
        return json({ error: { code: 'Forbidden' } }, auditStatus);
      return json({
        value: [],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/audits-next',
      });
    }
    if (url.pathname.endsWith('/audits-next'))
      return json({
        value: [
          {
            id: 'audit',
            activityDisplayName: 'Add member to group',
            result: 'success',
            activityDateTime: '2026-10-01T00:00:00Z',
            initiatedBy: { user: { userPrincipalName: 'admin@example.com' } },
            targetResources: [{ id: 'manual-0' }, { id: GROUP }],
          },
        ],
      });
    throw new Error(`Unexpected test URL ${url.href}`);
  });
  vi.stubGlobal('fetch', fetcher);
  await import('../src/sidepanel/panel');
  return {
    fetcher,
    sendMessage,
    tab,
    tabListeners,
    setAuditStatus: (value: number) => {
      auditStatus = value;
    },
  };
}

async function loadPage(page: 'sidepanel' | 'options'): Promise<void> {
  const template = document.createElement('template');
  template.innerHTML = await readFile(join('src', page, 'index.html'), 'utf8');
  template.content
    .querySelectorAll('link, script')
    .forEach((node) => node.remove());
  document.body.replaceChildren(template.content);
}

function button(id: string): HTMLButtonElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLButtonElement))
    throw new Error(`Missing button ${id}`);
  return node;
}

function chooseFilter(value: string): void {
  const select = document.getElementById('filter');
  if (!(select instanceof HTMLSelectElement)) throw new Error('Missing filter');
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

describe('side panel DOM', () => {
  it('renders and filters PIM active/eligible and nested rows without manual audit controls', async () => {
    await setupPanel(true, true, true);
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(11),
    );
    chooseFilter('pim');
    expect(document.querySelectorAll('.row')).toHaveLength(2);
    expect(document.getElementById('rows')?.textContent).toContain(
      'PIM (active)',
    );
    expect(document.getElementById('rows')?.textContent).toContain(
      'PIM (eligible only)',
    );
    expect(document.getElementById('rows')?.textContent).toContain(
      'eligibility alone does not grant membership',
    );
    expect(document.getElementById('rows')?.textContent).toContain(
      'Activated from',
    );
    expect(document.querySelectorAll('#rows button')).toHaveLength(0);
    chooseFilter('nested');
    expect(document.querySelectorAll('.row')).toHaveLength(1);
    expect(document.getElementById('rows')?.textContent).toContain(
      'Indirect membership through a nested group',
    );
    expect(document.querySelectorAll('#rows button, #rows img')).toHaveLength(
      0,
    );
    chooseFilter('manual');
    expect(document.querySelectorAll('.row')).toHaveLength(7);
    expect(document.getElementById('count')?.textContent).toBe(
      '7 of 11 memberships / eligibilities',
    );
  });

  it('shows sign-in state, renders safe package links and supports filters/sign-out', async () => {
    const app = await setupPanel(false);
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toContain(
        'sign in',
      ),
    );
    expect(app.fetcher).not.toHaveBeenCalled();
    button('signin').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(9),
    );
    expect(button('signin').hidden).toBe(true);
    expect(document.querySelectorAll('a[href*="entitlementId"]')).toHaveLength(
      2,
    );
    expect(document.querySelectorAll('#rows img, #rows script')).toHaveLength(
      0,
    );
    expect(document.getElementById('rows')?.textContent).toContain(
      '<script>unsafe</script>',
    );
    chooseFilter('access-package');
    expect(document.querySelectorAll('.row')).toHaveLength(1);
    chooseFilter('dynamic');
    expect(document.querySelectorAll('.row')).toHaveLength(0);
    chooseFilter('manual');
    expect(document.querySelectorAll('.row')).toHaveLength(8);
    button('signout').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(0),
    );
    expect(button('signin').hidden).toBe(false);
  });

  it('only looks up manual audit history lazily, follows paging, and isolates 403 errors', async () => {
    const app = await setupPanel();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(9),
    );
    expect(
      app.fetcher.mock.calls.some(([url]) =>
        String(url).includes('/directoryAudits'),
      ),
    ).toBe(false);
    const manual = [...document.querySelectorAll('.row')].find((row) =>
      row.textContent?.includes('Manual 0'),
    );
    const lookup = manual?.querySelector('button');
    if (!lookup) throw new Error('Missing lookup button');
    lookup.click();
    await vi.waitFor(() =>
      expect(manual?.textContent).toContain('admin@example.com'),
    );
    expect(
      app.fetcher.mock.calls.some(([url]) =>
        String(url).includes('/audits-next'),
      ),
    ).toBe(true);
    app.setAuditStatus(403);
    const second = [...document.querySelectorAll('.row')].find((row) =>
      row.textContent?.includes('Manual 1'),
    );
    second?.querySelector('button')?.click();
    await vi.waitFor(() =>
      expect(second?.textContent).toContain('AuditLog.Read.All'),
    );
    expect(document.querySelectorAll('.row')).toHaveLength(9);
    expect(document.getElementById('status')?.textContent).toContain(
      'Memberships loaded',
    );
  });

  it('does not request audit data when optional audit consent is disabled', async () => {
    const app = await setupPanel(true, false);
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(9),
    );
    expect(document.getElementById('rows')?.textContent).toContain(
      'Audit lookup disabled',
    );
    expect(
      [...document.querySelectorAll('#rows button')].every(
        (node) => node instanceof HTMLButtonElement && node.hidden,
      ),
    ).toBe(true);
    expect(
      app.fetcher.mock.calls.some(([url]) =>
        String(url).includes('/directoryAudits'),
      ),
    ).toBe(false);
  });

  it('limits visible manual-row audit lookups to four concurrent requests', async () => {
    const app = await setupPanel();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(9),
    );
    const original = app.fetcher.getMockImplementation();
    if (!original) throw new Error('Missing fetch mock');
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    app.fetcher.mockImplementation(async (input, init) => {
      if (!String(input).includes('/directoryAudits'))
        return original(input, init);
      peak = Math.max(peak, ++active);
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          active--;
          resolve(json({ value: [] }));
        });
      });
    });
    const observer = TestObserver.instances.at(-1);
    if (!observer) throw new Error('Missing lazy audit observer');
    observer.callback(
      [...observer.targets].map((target) => ({ target, isIntersecting: true })),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(peak).toBe(4);
    releases.slice(0, 4).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    releases.slice(4).forEach((release) => release());
    await vi.waitFor(() =>
      expect(
        document.querySelectorAll('#rows button:not([hidden])'),
      ).toHaveLength(0),
    );
    expect(peak).toBe(4);
  });

  it('surfaces main-list permission errors without retaining stale classifications', async () => {
    const app = await setupPanel();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(9),
    );
    app.fetcher.mockImplementation(async () =>
      json({ error: { code: 'Forbidden' } }, 403),
    );
    button('refresh').click();
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toContain(
        'GroupMember.Read.All',
      ),
    );
    expect(document.querySelectorAll('.row')).toHaveLength(0);
    expect(document.getElementById('status')?.getAttribute('role')).toBe(
      'alert',
    );
  });

  it('reloads on tab/context changes and clears stale rows on unsupported blades', async () => {
    const app = await setupPanel();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.row')).toHaveLength(9),
    );
    app.tab.url = groupUrl(OTHER);
    app.tabListeners[0]?.();
    await vi.waitFor(() =>
      expect(document.querySelector('.badge')?.textContent).toBe('Dynamic'),
    );
    expect(document.getElementById('rows')?.textContent).toContain('test rule');
    app.tab.url = 'https://entra.microsoft.com/#home';
    app.tabListeners[0]?.();
    await vi.waitFor(() =>
      expect(document.getElementById('status')?.textContent).toContain(
        'Open Group > Members',
      ),
    );
    expect(document.querySelectorAll('.row')).toHaveLength(0);
  });

  describe('options DOM', () => {
    it('loads settings, validates GUIDs, and saves changed configuration before test sign-in', async () => {
      await loadPage('options');
      const sync = storageArea({ settings });
      const calls: string[] = [];
      const sendMessage = vi.fn(async ({ type }: { type: string }) => {
        calls.push(type);
        return {
          ok: true,
          value: { signedIn: type === 'signIn', sessionId: 'session' },
        };
      });
      vi.stubGlobal('chrome', {
        identity: {
          getRedirectURL: () => 'https://extension.chromiumapp.org/',
        },
        runtime: { sendMessage },
        storage: { sync },
      });
      await import('../src/options/options');
      const client = document.getElementById('client');
      if (!(client instanceof HTMLInputElement))
        throw new Error('Missing client input');
      await vi.waitFor(() => expect(client.value).toBe(settings.clientId));
      expect(document.getElementById('redirect')?.textContent).toBe(
        'https://extension.chromiumapp.org/',
      );
      client.value = 'invalid';
      button('test').click();
      await vi.waitFor(() =>
        expect(document.getElementById('status')?.textContent).toContain(
          'Configure valid',
        ),
      );
      expect(sendMessage).not.toHaveBeenCalled();
      client.value = GROUP;
      button('test').click();
      await vi.waitFor(() =>
        expect(document.getElementById('status')?.textContent).toContain(
          'Sign-in succeeded',
        ),
      );
      expect(calls).toEqual(['signOut', 'signIn']);
      expect(sync.values.settings).toMatchObject({ clientId: GROUP });
    });
  });
});
