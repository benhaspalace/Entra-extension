import { parseContext, type EntraContext } from '../shared/context';
import { matchAudit } from '../shared/audit';
import { createGraphClient, GraphError } from '../shared/graph';
import { memberLink, packageLink } from '../shared/links';
import { errorMessage, request } from '../shared/messages';
import { readSettings } from '../shared/settings';
import type { DirectoryAudit } from '../shared/types';
import { loadMembership, type MembershipRow } from './data';

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing panel element: ${id}`);
  return node;
}

const status = element('status', HTMLParagraphElement);
const title = element('title', HTMLHeadingElement);
const rowsElement = element('rows', HTMLUListElement);
const filter = element('filter', HTMLSelectElement);
const count = element('count', HTMLParagraphElement);
const signIn = element('signin', HTMLButtonElement);
const signOut = element('signout', HTMLButtonElement);
const refresh = element('refresh', HTMLButtonElement);
const graph = createGraphClient((force) =>
  request('getToken', { refresh: force }),
);
let context: EntraContext | null = null;
let activeTabId: number | undefined;
let contextVersion = 0;
let rows: MembershipRow[] = [];
let controller = new AbortController();
let version = 0;
let auditEnabled = false;
let auditRunning = 0;
const auditQueue: (() => Promise<void>)[] = [];
let observer: IntersectionObserver | undefined;
const auditResults = new Map<string, string>();

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
  status.setAttribute('role', error ? 'alert' : 'status');
}

function appendText(parent: HTMLElement, text: string): void {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  parent.append(paragraph);
}

function link(text: string, href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.textContent = text;
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function drainAudits(): void {
  while (auditRunning < 4 && auditQueue.length) {
    const operation = auditQueue.shift();
    if (!operation) break;
    auditRunning++;
    void operation().finally(() => {
      auditRunning--;
      drainAudits();
    });
  }
}

function auditControls(row: MembershipRow, container: HTMLElement): () => void {
  const detail = document.createElement('p');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Look up who added this';
  detail.textContent = auditEnabled
    ? 'Audit history not yet loaded.'
    : 'Audit lookup disabled. Enable AuditLog.Read.All in Options to look up who added this.';
  button.hidden = !auditEnabled;
  container.append(detail, button);
  let started = false;
  const signal = controller.signal;
  const rowVersion = version;
  const key = `${row.group.id}:${row.member.id}`;
  const cached = auditResults.get(key);
  if (cached) {
    detail.textContent = cached;
    button.hidden = true;
    started = true;
  }
  function lookup(): void {
    if (started || signal.aborted || rowVersion !== version || !auditEnabled)
      return;
    started = true;
    detail.classList.remove('error');
    button.disabled = true;
    detail.textContent = 'Waiting for audit lookup...';
    auditQueue.push(async () => {
      if (signal.aborted) return;
      try {
        detail.textContent = 'Looking up audit history...';
        const events = await graph.list<DirectoryAudit>(
          `/auditLogs/directoryAudits?$filter=${encodeURIComponent(`activityDisplayName eq 'Add member to group' and targetResources/any(t:t/id eq '${row.member.id}')`)}&$orderby=activityDateTime desc&$top=50`,
          'AuditLog.Read.All',
          signal,
        );
        if (rowVersion !== version || signal.aborted) return;
        const attribution = matchAudit(events, row.group.id, row.member.id);
        detail.textContent = attribution
          ? `${attribution.historicalPackage ? 'Access package (historical). ' : ''}Added by: ${attribution.actor}, ${new Date(attribution.when).toLocaleString()}.`
          : 'Added by: unknown (older than audit retention, or no matching successful event retained).';
        auditResults.set(key, detail.textContent);
        button.hidden = true;
      } catch (error) {
        if (signal.aborted || rowVersion !== version) return;
        detail.textContent = errorMessage(error);
        detail.classList.add('error');
        button.textContent = 'Retry audit lookup';
        button.disabled = false;
        started = false;
        if (error instanceof GraphError && error.status === 401) {
          setStatus(error.message, true);
          signIn.hidden = false;
        }
      }
    });
    drainAudits();
  }
  button.addEventListener('click', lookup);
  return lookup;
}

function renderRows(): void {
  observer?.disconnect();
  rowsElement.replaceChildren();
  const visible = rows.filter(
    (row) => filter.value === 'all' || row.governance.source === filter.value,
  );
  count.textContent = `${visible.length} of ${rows.length} memberships / eligibilities`;
  const lookups = new Map<Element, () => void>();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lookups.get(entry.target)?.();
        observer?.unobserve(entry.target);
      }
    },
    { rootMargin: '100px' },
  );
  for (const row of visible) {
    const item = document.createElement('li');
    item.className = 'row';
    const subject = context?.kind === 'user' ? row.group : row.member;
    const kind =
      context?.kind === 'user' ||
      subject['@odata.type'] === '#microsoft.graph.group'
        ? 'group'
        : 'user';
    const name = subject.displayName ?? subject.userPrincipalName ?? subject.id;
    if (
      context?.kind === 'user' ||
      !subject['@odata.type'] ||
      subject['@odata.type'] === '#microsoft.graph.user' ||
      subject['@odata.type'] === '#microsoft.graph.group'
    )
      item.append(link(name, memberLink(kind, subject.id)));
    else {
      appendText(item, name);
      item.append(link('Open group', memberLink('group', row.group.id)));
    }
    if (subject.userPrincipalName) appendText(item, subject.userPrincipalName);
    const badge = document.createElement('span');
    badge.className = 'badge';
    const governance = row.governance;
    badge.textContent = {
      'access-package': 'Access package',
      pim:
        governance.source === 'pim' && governance.status === 'eligible'
          ? 'PIM (eligible only)'
          : 'PIM (active)',
      nested: 'Nested',
      dynamic: 'Dynamic',
      synced: 'Synced (AD)',
      manual: 'Manual',
    }[governance.source];
    item.append(document.createElement('br'), badge);
    if (governance.source === 'access-package') {
      const byPackage = new Map<string, typeof governance.packages>();
      for (const grant of governance.packages) {
        const grants = byPackage.get(grant.id) ?? [];
        grants.push(grant);
        byPackage.set(grant.id, grants);
      }
      for (const grants of byPackage.values()) {
        const first = grants[0];
        if (!first) continue;
        const paragraph = document.createElement('p');
        paragraph.append(link(first.name, packageLink(first.id)));
        for (const grant of grants) {
          const expiry = grant.expiresAt
            ? ` - expires ${new Date(grant.expiresAt).toLocaleString()}`
            : grant.duration
              ? ` - expires after ${grant.duration}${grant.startsAt ? ` from ${new Date(grant.startsAt).toLocaleString()}` : ''}`
              : ' - no fixed expiry returned';
          paragraph.append(document.createTextNode(expiry));
        }
        item.append(paragraph);
      }
    } else if (governance.source === 'pim') {
      appendText(
        item,
        governance.status === 'eligible'
          ? 'Eligible for activation; eligibility alone does not grant membership.'
          : 'Active membership managed by PIM for Groups.',
      );
      for (const instance of governance.instances) {
        appendText(
          item,
          `${instance.assignmentType === 'activated' ? 'Activated' : governance.status === 'active' ? 'Assigned' : 'Eligible'} from ${new Date(instance.startDateTime).toLocaleString()}${instance.endDateTime ? ` until ${new Date(instance.endDateTime).toLocaleString()}` : ' (no expiration)'}.`,
        );
      }
    } else if (governance.source === 'nested')
      appendText(
        item,
        'Indirect membership through a nested group. The intermediate group path is not resolved.',
      );
    else if (governance.source === 'dynamic') appendText(item, governance.rule);
    else if (governance.source === 'manual') {
      const lookup = auditControls(row, item);
      if (auditEnabled) lookups.set(item, lookup);
    }
    if (
      row.eligibility.length &&
      !(governance.source === 'pim' && governance.status === 'eligible')
    )
      appendText(
        item,
        'Also eligible through PIM for Groups; eligibility is not the cause of the current membership.',
      );
    rowsElement.append(item);
    if (lookups.has(item)) observer.observe(item);
  }
}

async function reload(): Promise<void> {
  controller.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const loadVersion = ++version;
  auditQueue.length = 0;
  auditResults.clear();
  observer?.disconnect();
  rows = [];
  rowsElement.replaceChildren();
  title.textContent = '';
  count.textContent = '';
  refresh.disabled = true;
  try {
    const auth = await request('authStatus', undefined);
    if (loadVersion !== version) return;
    signIn.hidden = auth.signedIn;
    signOut.hidden = !auth.signedIn;
    if (!auth.signedIn || !auth.sessionId) {
      setStatus(
        'Set your tenant and client IDs in Options, then sign in to Microsoft Entra.',
      );
      return;
    }
    if (!context) {
      setStatus(
        'Open Group > Members or User > Groups in the Entra admin center.',
      );
      return;
    }
    const settings = await readSettings();
    if (loadVersion !== version || signal.aborted) return;
    auditEnabled = settings.auditEnabled;
    setStatus('Loading memberships, access packages and PIM governance...');
    const data = await loadMembership(context, graph, auth.sessionId, signal);
    if (loadVersion !== version || signal.aborted) return;
    title.textContent = data.title;
    rows = data.rows;
    renderRows();
    setStatus(
      rows.length
        ? 'Memberships loaded. Audit lookups run lazily for visible manual rows.'
        : 'No memberships or PIM eligibilities found.',
    );
  } catch (error) {
    if (loadVersion !== version || signal.aborted) return;
    controller.abort();
    setStatus(errorMessage(error), true);
    signIn.hidden = false;
  } finally {
    if (loadVersion === version) refresh.disabled = false;
  }
}

async function updateContext(): Promise<void> {
  const queryVersion = ++contextVersion;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (queryVersion !== contextVersion) return;
    const next = parseContext(tab?.url ?? '');
    if (
      activeTabId !== tab?.id ||
      next?.kind !== context?.kind ||
      next?.id !== context?.id
    ) {
      activeTabId = tab?.id;
      context = next;
      await reload();
    }
  } catch (error) {
    setStatus(errorMessage(error), true);
  }
}

async function authentication(action: 'signIn' | 'signOut'): Promise<void> {
  const button = action === 'signIn' ? signIn : signOut;
  button.disabled = true;
  setStatus(
    action === 'signIn'
      ? 'Complete sign-in in the Microsoft window...'
      : 'Signing out...',
  );
  try {
    await request(action, undefined);
    await reload();
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    button.disabled = false;
  }
}

signIn.addEventListener('click', () => void authentication('signIn'));
signOut.addEventListener('click', () => void authentication('signOut'));
refresh.addEventListener('click', () => void reload());
filter.addEventListener('change', renderRows);
element('options', HTMLButtonElement).addEventListener('click', () => {
  void chrome.runtime
    .openOptionsPage()
    .catch((error: unknown) => setStatus(errorMessage(error), true));
});
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (
    sender.id === chrome.runtime.id &&
    sender.tab?.id === activeTabId &&
    message &&
    typeof message === 'object' &&
    'type' in message &&
    message.type === 'contextChanged'
  )
    void updateContext();
});
chrome.tabs.onActivated.addListener(() => void updateContext());
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === activeTabId && change.url) void updateContext();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) void reload();
  if (area === 'session' && changes.auth) {
    const before = changes.auth.oldValue as { sessionId?: string } | undefined;
    const after = changes.auth.newValue as { sessionId?: string } | undefined;
    if (before?.sessionId !== after?.sessionId) void reload();
  }
});
void updateContext().then(() => {
  if (activeTabId === undefined) return reload();
});
