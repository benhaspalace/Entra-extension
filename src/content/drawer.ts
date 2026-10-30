import {
  formatDate,
  formatExpiration,
  formatRequestor,
  groupAssignments,
} from '../shared/accessPackages';
import { memberLink, packageLink } from '../shared/links';
import { errorMessage, request } from '../shared/messages';
import type { AssignmentRequest, UserPackageAssignment } from '../shared/types';

const STYLES = `
:host { all: initial; position: fixed; inset: 0 0 0 auto; width: min(520px, 100vw);
  z-index: 2147483647; color-scheme: light; }
* { box-sizing: border-box; }
section { height: 100%; padding: 20px; overflow: auto; background: #fff; color: #242424;
  box-shadow: -4px 0 20px #0004; font: 14px/1.5 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0 0 16px; } h2 { font-size: 18px; }
button { font: inherit; margin: 0 8px 8px 0; padding: 6px 10px; cursor: pointer; }
a { color: #005a9e; overflow-wrap: anywhere; }
ul { padding-left: 20px; } li { margin-bottom: 12px; }
p { margin: 4px 0; overflow-wrap: anywhere; } article { padding: 12px 0; border-bottom: 1px solid #ddd; }
[role="alert"] { color: #a4262c; } :focus-visible { outline: 2px solid #005a9e; outline-offset: 2px; }
`;

function text(tag: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function link(label: string, href: string): HTMLAnchorElement {
  const node = document.createElement('a');
  node.textContent = label;
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}

function assignmentRow(assignment: UserPackageAssignment): HTMLElement {
  const row = document.createElement('article');
  const pkg = assignment.accessPackage;
  row.append(
    pkg
      ? link(pkg.displayName ?? pkg.id, packageLink(pkg.id))
      : text('p', 'Access package not provided'),
    text('p', `Catalog: ${pkg?.catalog?.displayName ?? 'Not provided'}`),
    text(
      'p',
      `Policy: ${assignment.assignmentPolicy?.displayName ?? 'Not provided'}`,
    ),
    text('p', `State: ${assignment.state}`),
    text('p', `Start: ${formatDate(assignment.schedule?.startDateTime)}`),
    text('p', `Expiry: ${formatExpiration(assignment.schedule)}`),
    text('p', 'Resources (current package configuration):'),
  );
  const resources = document.createElement('ul');
  for (const resource of assignment.resources) {
    const item = document.createElement('li');
    item.append(
      resource.system.toLowerCase() === 'aadgroup'
        ? link(resource.name, memberLink('group', resource.id))
        : text('span', `${resource.name} (${resource.system})`),
    );
    resources.append(item);
  }
  row.append(
    resources.childElementCount
      ? resources
      : text('p', 'No resources returned'),
  );
  return row;
}

export interface Drawer {
  close(): void;
}

function requestRow(request: AssignmentRequest): HTMLElement {
  const row = document.createElement('article');
  const pkg = request.accessPackage;
  row.append(
    pkg
      ? link(pkg.displayName ?? pkg.id, packageLink(pkg.id))
      : text('p', 'Access package not provided'),
    text('p', `Requested: ${formatDate(request.createdDateTime)}`),
    text('p', `Requestor: ${formatRequestor(request.requestor)}`),
  );
  return row;
}

export function openDrawer(userId: string, returnFocus: HTMLElement): Drawer {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = text('style', STYLES);
  const panel = document.createElement('section');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', 'drawer-title');
  const title = text('h1', `Access packages \u2014 ${userId}`);
  title.id = 'drawer-title';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  const sidePanel = document.createElement('button');
  sidePanel.type = 'button';
  sidePanel.textContent = 'Open in side panel';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Refresh';
  const status = text('p', '');
  status.setAttribute('role', 'status');
  const content = document.createElement('div');
  panel.append(title, closeButton, sidePanel, refresh, status, content);
  shadow.append(style, panel);
  document.body.append(host);
  let closed = false;
  let version = 0;
  function close(): void {
    closed = true;
    version++;
    host.remove();
    if (returnFocus.isConnected) returnFocus.focus();
  }
  function showError(error: unknown): void {
    status.setAttribute('role', 'alert');
    status.textContent = errorMessage(error);
  }
  async function load(): Promise<void> {
    const current = ++version;
    refresh.disabled = true;
    content.replaceChildren();
    status.setAttribute('role', 'status');
    status.textContent = 'Loading access package assignments and requests...';
    try {
      const data = await request('getUserAccessPackages', { userId });
      if (closed || current !== version) return;
      title.textContent = `Access packages \u2014 ${data.displayName}`;
      const groups = groupAssignments(data.assignments);
      for (const [label, assignments] of [
        ['Active', groups.active],
        ['Expired / failed', groups.inactive],
      ] as const) {
        content.append(text('h2', label));
        if (!assignments.length) content.append(text('p', 'None'));
        for (const assignment of assignments)
          content.append(assignmentRow(assignment));
      }
      content.append(text('h2', 'Pending requests'));
      if (data.pendingRequestsError) {
        const error = text(
          'p',
          `Could not load pending requests: ${data.pendingRequestsError} Use Refresh to retry.`,
        );
        error.setAttribute('role', 'alert');
        content.append(error);
      } else if (!data.pendingRequests.length)
        content.append(text('p', 'No pending requests'));
      for (const pendingRequest of data.pendingRequests)
        content.append(requestRow(pendingRequest));
      status.textContent = data.pendingRequests.length
        ? `${data.assignments.length} assignments. ${data.pendingRequests.length} pending requests. Dates are UTC.`
        : data.assignments.length
          ? `${data.assignments.length} assignments. Dates are UTC.`
          : 'No access package assignments';
    } catch (error) {
      if (!closed && current === version) showError(error);
    } finally {
      if (!closed && current === version) refresh.disabled = false;
    }
  }
  closeButton.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  sidePanel.addEventListener('click', () => {
    void request('openSidePanel', undefined).catch(showError);
  });
  refresh.addEventListener('click', () => void load());
  closeButton.focus();
  void load();
  return { close };
}
