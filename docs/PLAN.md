# Entra Admin Helper — Plan

Browser extension (Chrome / Edge, Manifest V3) that adds governance context to the
Microsoft Entra admin center (`https://entra.microsoft.com/`).

## Feature 1: "Why is this member in this group?"

For every member of a group, show how the membership is governed:

| Source                     | How we detect it                                                                                                                                                                                                                                                                                                                                                                                      | What we show                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access package**         | An active (`delivered`, `partiallyDelivered`, or `delivering`) `accessPackageAssignment` whose access package grants the group's **Member** role (`resourceRoleScopes[].scope.originId == groupId`, `originSystem == 'AadGroup'`, and `role.originId` starts with `Member_` or `role.displayName == 'Member'`) and whose `target.objectId == memberId`. Owner-only packages do not govern membership. | Badge "Access package" + one hyperlink per package (a member may hold several), plus assignment expiry if any                                                                                                    |
| **Dynamic rule**           | `group.groupTypes` contains `DynamicMembership`                                                                                                                                                                                                                                                                                                                                                       | Badge "Dynamic" + the membership rule                                                                                                                                                                            |
| **Synced from on-prem AD** | `group.onPremisesSyncEnabled == true`                                                                                                                                                                                                                                                                                                                                                                 | Badge "Synced (AD)"                                                                                                                                                                                              |
| **Manual**                 | None of the above                                                                                                                                                                                                                                                                                                                                                                                     | Badge "Manual" + _who_ added it and _when_, from the directory audit log (`Add member to group`), if still within audit retention (30 days on P1/P2); otherwise "added by: unknown (older than audit retention)" |

A member can be both access-package governed **and** manually added (e.g. added by
hand before the package existed). Access package always wins as the primary label; the
audit lookup is only performed for members without a package (or on demand).

Two entry points, both derived from the current Entra URL:

1. **Group → Members** blade (`.../GroupDetailsMenuBlade/~/Members/groupId/<guid>`): list
   all direct members with their governance source.
2. **User → Groups** blade (`.../UserProfileMenuBlade/~/Groups/userId/<guid>`): list all
   groups the user is a direct member of, with the governance source for each.

## Feature 2: "Access packages" item in the user profile menu

On the user profile blade
(`#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/<anything>/userId/<guid>`)
inject a menu entry **"Access packages"** directly **above "Custom security attributes"**
in the left resource menu (Overview, Audit logs, Sign-in logs, Diagnose and solve
problems, _Access packages_, Custom security attributes, Assigned roles, …).

Injection (content script, top frame only — the resource menu is rendered in the shell
document, not in a blade iframe):

- `MutationObserver` on `document.body` (the portal is an SPA and re-renders the menu on
  every blade navigation); throttle to at most one run every 250 ms, observing child-list
  changes only (not character data); only active while the URL matches the user profile blade.
- Locate the anchor item: the menu element whose trimmed text is exactly
  `Custom security attributes` (label list in `src/content/menuLabels.ts` so localized
  labels can be added), using a TreeWalker over text nodes. Climb to the item container
  (`closest('[role="listitem"], [role="treeitem"], [role="menuitem"], li')`).
  Choose the last visible match (`getClientRects().length > 0`), skipping hidden blades;
  fall back to the last match only if document layout is unavailable.
- Clone the container (`cloneNode(true)` — listeners are not cloned), replace the label
  text and icon (inline SVG, no external fetch), strip `id`s / `aria-selected` /
  selected-state classes, mark it with `data-entra-helper="access-packages"`, insert before
  the anchor. Idempotent: never insert twice; re-insert if the portal re-renders the menu.
- If the anchor cannot be found, inject nothing (the side panel still works).
- Keyboard accessible: `tabindex=0`, Enter/Space activate.
- Ignore untrusted click/keydown events on the injected menu item.

On click: open an **in-page drawer** (fixed-position panel on the right, rendered in a
closed Shadow DOM so portal CSS cannot leak in either direction) titled
"Access packages — <user display name>". The content script never calls Graph itself; it
asks the background service worker (`chrome.runtime.sendMessage`), which owns the token.
Also offer an "Open in side panel" button.

Drawer contents for the user:

- `GET /identityGovernance/entitlementManagement/assignments?$filter=target/objectId eq '{userId}'&$expand=accessPackage($expand=catalog),assignmentPolicy`
  — grouped into **Active** (`delivered`, `partiallyDelivered`, `delivering`) and
  **Expired / failed**. Per row: access package name (hyperlink), catalog, policy name,
  state, start date, expiry date (or "No expiration"), and the resources the package grants
  (groups as hyperlinks, from the cached package → resource map of feature 1).
- Pending requests (`assignmentRequests`) are backlog; phase 1 shows assignments only.
- Empty state: "No access package assignments". Error states as in the side panel.

## UI decision: side panel first, inline badges second

The Entra admin center is built on the Azure Portal ("Ibiza") framework: most blades are
rendered inside cross-origin iframes (`*.reactblade.portal.azure.net`, etc.) with
virtualised Fluent grids and generated class names. Injecting into those grids is
possible but brittle (breaks on every portal release, must handle virtual scrolling).

Therefore:

- **Phase 1 (this PR): Side panel** (`chrome.sidePanel`). A content script on
  `entra.microsoft.com` only watches the URL hash (`hashchange` + polling, since Ibiza
  uses `history.pushState`) and tells the side panel which group/user is open. The panel
  does all data fetching and rendering. Robust against portal DOM changes.
- **Phase 2 (later, behind an option, off by default):** best-effort inline badges in the
  Members grid by matching row text (UPN / display name) to the data the panel already
  loaded. If matching fails nothing is injected — the side panel remains the source of truth.

## Authentication

The extension cannot safely reuse the portal's own tokens (they are scoped to portal
first-party apps and live in other origins' storage). It signs in on its own:

- OAuth 2.0 authorization code flow + PKCE via `chrome.identity.launchWebAuthFlow`.
- Requires an **app registration** in the tenant (documented in `docs/SETUP.md`):
  - Platform: _Single-page application_, redirect URI `https://<extension-id>.chromiumapp.org/`
  - Delegated Graph permissions: `User.Read`, `GroupMember.Read.All`,
    `EntitlementManagement.Read.All`, `AuditLog.Read.All` (audit is optional — the feature
    degrades gracefully without it), admin consent granted.
- Tenant ID + client ID are entered in the options page (`chrome.storage.sync`).
- Tokens are kept in `chrome.storage.session` only (memory-backed, cleared on browser
  restart), refreshed with the refresh token, never written to `storage.local`.
- The signed-in admin still needs a directory role that can read entitlement management
  (e.g. Identity Governance Administrator, Global Reader) — Graph enforces this.

## Graph calls (v1.0)

1. `GET /groups/{id}?$select=id,displayName,groupTypes,membershipRule,onPremisesSyncEnabled`
2. `GET /groups/{id}/members?$select=id,displayName,userPrincipalName,mail&$top=999` (paged)
3. Access packages containing the group:
   - `GET /identityGovernance/entitlementManagement/accessPackages?$expand=resourceRoleScopes($expand=role,scope)&$select=id,displayName`
     (paged; cached in `chrome.storage.session` for 15 min, since it is tenant-wide),
     keep those with an AadGroup scope where `originId == groupId` and the Member role.
     Only if an expanded collection carries `resourceRoleScopes@odata.nextLink`, reload
     that package's complete collection through the paged
     `GET .../accessPackages/{id}/resourceRoleScopes?$expand=role,scope` list.
     Cache-write failures are reported but do not discard successfully fetched data.
4. For each matching package:
   `GET /identityGovernance/entitlementManagement/assignments?$filter=accessPackage/id eq '{pkg}' and (state eq 'delivered' or state eq 'partiallyDelivered' or state eq 'delivering')&$expand=target&$select=id,state,schedule`
   → map `target.objectId` → list of packages.
5. Manual members (lazy, concurrency-limited to 4, plus a "Look up" button per row):
   `GET /auditLogs/directoryAudits?$filter=activityDisplayName eq 'Add member to group' and targetResources/any(t:t/id eq '{memberId}')&$orderby=activityDateTime desc&$top=50`
   then match the group id client-side (`targetResources[].id` or the `Group.ObjectID`
   modified property). Actor = `initiatedBy.user.userPrincipalName` or
   `initiatedBy.app.displayName`. If the actor app is the identity governance service,
   label it "Access package (historical)" (case-insensitive app-name substring
   `entitlement management` or `identity governance`, or the known service app ID).

For the **User → Groups** view: fetch the title using
`GET /users/{id}?$select=displayName,userPrincipalName`,
`GET /users/{id}/memberOf/microsoft.graph.group?$select=...`,
`GET .../assignments?$filter=target/objectId eq '{userId}' and (state eq 'delivered' or state eq 'partiallyDelivered' or state eq 'delivering')&$expand=accessPackage`
and the cached package→group map from (3).

All calls go through one `graphFetch` helper: auth header, `@odata.nextLink` paging,
429/503 retry honouring `Retry-After` up to 60 seconds (longer waits throw a throttling
error instead of sleeping), typed errors (401 → re-auth, 403 → "missing
permission/role" message naming the scope).

## Hyperlinks

- Access package: `https://entra.microsoft.com/#view/Microsoft_Azure_ELMAdmin/EntitlementMenuBlade/~/overview/entitlementId/{accessPackageId}`
- User: `https://entra.microsoft.com/#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/{id}`
- Group: `https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/{id}`

Built in one module (`src/shared/links.ts`) so they can be fixed in one place.

## Tech stack

- TypeScript (strict), no UI framework (small, auditable), esbuild bundling.
- Vitest for unit tests (URL parsing, classification logic, paging, audit matching) with
  mocked Graph responses.
- ESLint + Prettier. `npm run build` → `dist/` loadable as an unpacked extension.

## Layout

```
manifest.json              MV3, side_panel, permissions: identity, storage, sidePanel, tabs
src/background/            service worker: auth (PKCE), message routing, side panel enable per tab
src/content/               URL watcher on entra.microsoft.com → posts context to background
src/sidepanel/             panel UI (index.html, panel.ts, styles.css)
src/options/               tenant/client id settings + "test sign-in"
src/shared/graph.ts        graphFetch, paging, retry
src/shared/governance.ts   classification logic (pure, unit tested)
src/shared/context.ts      Entra URL → {kind:'group'|'user', id}
src/shared/links.ts        portal deep links
test/                      vitest
docs/SETUP.md              app registration + load unpacked instructions
```

## Delivery via GitHub Copilot agents

- Implementation agent: GitHub Copilot CLI (`copilot -p … --allow-all-tools`) working in
  this repo against this plan and `AGENTS.md`.
- Review agent: a second Copilot CLI run with a different model, read-only
  (`--deny-tool write --deny-tool shell`), reviewing the diff against this plan.
- Claude Code only orchestrates scripts and reads their results. Scripts run the quality
  gate and route implementation, reviews, comment fixes, and conflict resolution to
  Copilot models through the shared harness runner (see `docs/HARNESS.md`).

## Out of scope for phase 1 / backlog

- Inline badges in the portal grid (phase 2).
- PIM for Groups (eligible/active assignments), nested/transitive membership explanation.
- Firefox build (needs `browser.identity` redirect URL differences).
- Access reviews / lifecycle workflow attribution.
