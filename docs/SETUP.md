# Setup

The extension uses its **own** delegated Microsoft Graph sign-in. It never reads
Entra portal tokens, cookies or storage. Supported browsers are desktop Microsoft
Edge and Google Chrome 116 or newer, in the commercial Microsoft cloud.

## 1. Build and load unpacked

Install Node.js 22.12 or newer (use an active LTS release), then run in this repository:

```powershell
npm install
npm run build
npm test
npm run lint
npm run typecheck
```

In Edge open `edge://extensions`; in Chrome open `chrome://extensions`. Enable
**Developer mode**, choose **Load unpacked**, and select this repository's `dist`
directory, not the repository root. No server is required. Icons are generated
locally by `scripts/icons.mjs` as part of the build.

Open the extension's **Options** page from its extension details. Copy the exact
redirect URI displayed there: `https://<extension-id>.chromiumapp.org/`.
Extension IDs can differ between browsers, profiles and unpacked directory paths;
register each exact URI. After a rebuild, click **Reload** in the extensions page
and reload any already-open Entra portal tabs.

## 2. Register a single-tenant SPA

In the tenant you administer, open **Entra ID > App registrations > New registration**.

1. Name it, for example, `Entra Admin Helper`.
2. Select **Accounts in this organizational directory only**.
3. Under **Authentication > Add a platform**, choose **Single-page application**.
   Add the exact redirect URI copied from Options, including the trailing slash.
   Do not register it as a Web redirect.
4. Do **not** create a client secret. Do not enable implicit access-token or ID-token
   grants. The extension uses authorization code + S256 PKCE; a public SPA has no secret.
5. Under **API permissions > Microsoft Graph > Delegated permissions**, add:

| Permission                       | Purpose                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `User.Read`                      | Basic signed-in user access                               |
| `GroupMember.Read.All`           | Read direct memberships and group properties              |
| `EntitlementManagement.Read.All` | Read packages, resource scopes and assignments            |
| `AuditLog.Read.All` (optional)   | Find the actor and time for retained membership additions |

An authorized administrator must **grant admin consent** in this tenant. The
authorization request also includes standard `openid`, `profile`, and
`offline_access` scopes so the session can refresh. No application permissions,
write permissions or portal first-party client IDs are used.

The signed-in user needs appropriate directory roles as well as OAuth consent.
For entitlement management, use a supported role such as **Identity Governance
Administrator** or **Global Reader**. Audit access additionally requires a supported
role such as **Reports Reader**, **Security Reader**, or **Global Reader**. Tenant
licensing and entitlement management availability also apply; consent alone does
not confer a role.

## 3. Configure and sign in

Copy **Directory (tenant) ID** and **Application (client) ID** from the app
registration's Overview into Options. GUIDs are required (not tenant domains,
`common`, or `organizations`).

If audit access isn't available, uncheck **Request AuditLog.Read.All** before
signing in. The rest of the extension still works without audit permission.
Choose **Save and test sign-in**, then complete Microsoft's account selection,
consent and any MFA/Conditional Access prompts. Saving changed settings clears
the previous extension session. This sign-in is independent of the portal's
account: choose the same tenant/account you intend to inspect.

## 4. Use the panel

Open `https://entra.microsoft.com/`, navigate to either:

- **Group > Members** (`GroupDetailsMenuBlade/~/Members/groupId/<guid>`).
- **User > Groups** (`UserProfileMenuBlade/~/Groups/userId/<guid>`).

Click the pinned extension toolbar action to open its side panel. Navigation is
detected from the URL only (hash changes, history navigation and one-second
polling). Membership detection does not inspect the portal DOM; only the user
profile menu integration below reads the shell DOM.

The panel lists **direct** memberships, with an All / Access package / Manual /
Dynamic filter. Synced rows appear under All. Each package has its own portal link
and assignment expiry information. Duration-based schedules show the ISO 8601
duration and start date. Member/group links open the corresponding Entra blade.

Delivered access packages take precedence, then dynamic rules, then on-premises
sync, then manual membership. Historical audit attribution does not change the
current classification. Visible manual rows lazily look up retained successful
`Add member to group` events with at most four concurrent requests; each also has
a **Look up** / **Retry** button. No result means **unknown**, not evidence that
the member was definitely added manually or by a particular actor.

**Refresh** reloads memberships and assignments. The complete package-to-group
map is cached for up to 15 minutes per sign-in session in `chrome.storage.session`;
newly changed package resources may therefore take that long to appear. Sign out
and back in to discard the map immediately. Package role scopes are fetched as
separate paged lists rather than relying on potentially truncated nested expands.
All Graph calls use v1.0 and follow every `@odata.nextLink`.

## 5. Use the user profile Access packages drawer

Open any user profile section with a URL matching
`#view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/<section>/userId/<guid>`.
In the left resource menu, choose **Access packages**, directly above
**Custom security attributes**. Enter and Space also activate the item.

The right-hand drawer lists assignments grouped into **Active** (`delivered`,
`partiallyDelivered`, `delivering`) and **Expired / failed** (all other states).
Each row shows a package link, catalog, policy, state, UTC start/expiry dates and
the package's current resources; groups link to their Entra blades. Explicit
non-expiring schedules show **No expiration**; duration-based schedules show the
duration and start. Missing dates are shown as **Not provided**, not assumed to be
non-expiring. Pending assignment requests are not included.

The drawer gets data from the background worker, using the existing extension
sign-in and the same session-scoped, 15-minute package/resource cache as the
membership panel. It does not read portal credentials or call Graph itself.
Its title uses the assignment target's display name, falling back to the user ID
when no target name is returned (including an empty assignment list); no extra
profile-read permission is requested. Package resources reflect the current
cached configuration, not a historical snapshot of an expired assignment.

Use **Refresh** to reload assignments (the resource cache still lasts up to
15 minutes), **Close** or Escape to dismiss, and **Open in side panel** to access
sign-in or the existing membership views. On an Overview section, the side panel
asks you to navigate to **User > Groups** or **Group > Members**.
No assignments shows **No access package assignments**; sign-in, permission and
network failures are shown explicitly and can be retried with **Refresh**.

The menu is cloned from a shell resource-menu item, without its navigation,
selection state or listeners. It is reinserted after portal rerenders and removed
when leaving the user profile; changing users also closes the drawer. The drawer
is isolated in a closed Shadow DOM. If the anchor label cannot be found, nothing
is injected and the existing side panel remains usable. Currently the label list
in `src/content/menuLabels.ts` supports English; additional localized anchor labels
can be added there.

## Troubleshooting and limits

- **401 / expired session:** sign in again. The helper first attempts one token
  refresh. SPA refresh tokens have limited lifetimes and Conditional Access may
  require interaction.
- **403:** the error names the delegated permission for that operation. Verify
  consent, directory role, tenant licensing and that you chose the intended account.
  Audit-only failures stay on the affected manual row; package failures stop the
  main list rather than falsely classifying members as manual.
- **Redirect or token exchange error:** check the extension ID and exact **SPA**
  redirect URI in this browser/profile. Never work around this by adding a secret.
- **No context:** use the exact Members/Groups blades above, not Overview or a
  different Entra host for the membership panel. The Access packages drawer works
  on any matching user profile section. Encoded and double-encoded hash routes
  are supported.
- **Access packages item missing:** use the user profile blade on
  `entra.microsoft.com` and check for the English **Custom security attributes**
  anchor in the shell menu. A localized or changed portal menu is skipped safely.
  Reload the portal after reloading the extension.
- **Unknown audit attribution:** typical P1/P2 audit retention is 30 days (tenant
  policy/licensing may differ). Removed/re-added memberships and service actions
  mean the latest retained successful addition is historical evidence only.
- Graph may return only an ID/type for inaccessible directory objects; the panel
  displays that ID rather than inventing a name. The v1.0 `/groups/{id}/members`
  endpoint has a documented service-principal omission; this phase follows the
  plan's v1.0 endpoint and cannot claim those omitted objects are absent.
  Hidden memberships can require `Member.Read.Hidden`, which isn't requested in
  this phase. User > Groups titles use the user's ID, avoiding an extra
  `User.Read.All` requirement solely for profile display.
- PIM eligibility, nested/transitive membership explanations, inline portal badges,
  national clouds and Firefox are not implemented in phase 1.

Settings are stored in `chrome.storage.sync`. Access/refresh tokens and the
account-scoped package cache stay only in memory-backed `chrome.storage.session`,
which is not exposed to content scripts and is cleared by browser restart or the
extension's **Sign out** action. Sign out does not log the browser out of Microsoft.
There is no telemetry. Requests can only target `https://graph.microsoft.com`
and `https://login.microsoftonline.com`; Graph continuations outside v1.0 are rejected.

## Suggested browser acceptance check

After registration, verify both views with a user who has two delivered packages
granting the same group, a dynamic group, an AD-synced group, and a manual membership.
Follow all package/member/group links, switch tabs and blades, try every filter,
and verify manual attribution and the no-audit-permission case. Sign out and confirm
the list clears; restart the browser and confirm sign-in is required again.
Unit tests mock Graph and Chrome; they do not replace this tenant-backed check.
On a user profile, check that **Access packages** appears once immediately above
**Custom security attributes**, including after switching sections and portal menu
rerenders. Open it with mouse, Enter and Space; verify active/expired assignments,
catalog/policy/dates, resource links, empty state, signed-out and 403 errors, retry,
side-panel opening, Close/Escape, and cleanup when switching users or leaving the
profile. The menu fixtures use jsdom; a live portal check is still necessary.
