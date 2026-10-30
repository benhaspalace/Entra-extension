# Entra Admin Helper

A Manifest V3 extension for Microsoft Edge / Chrome that explains **group
membership** in the Microsoft Entra admin center.

Phase 1 provides a side panel for **Group > Members** and **User > Groups**. It shows
delivered access packages (including multiple package links and expiry), dynamic
rules, AD sync, active PIM for Groups, nested membership, or manual membership
with lazy audit-log attribution. PIM eligibilities are shown separately from
current membership. Filter rows
by governance source and open the relevant Entra blades from each row.

On any **User profile** blade, an **Access packages** menu item appears directly
above **Custom security attributes**. It opens an in-page drawer with active and
expired/failed assignments, catalog, policy, dates and package resources, including
group links. The drawer also offers **Open in side panel** for sign-in and the
existing membership views. Pending requests are not included.

The extension uses its own authorization code + PKCE sign-in and Microsoft Graph
v1.0, never portal tokens. A top-frame content script inspects only the shell DOM
to clone the menu item; the drawer uses a closed Shadow DOM, and its Graph work
runs in the background worker. Tenant/client settings sync through the browser;
tokens and a shared 15-minute package map stay in session storage only.

## Get started

Requires Node.js 22.12+ and Chrome / Edge 116+.

```powershell
npm install
npm run build
npm test
npm run lint
npm run typecheck
```

Load `dist` as an unpacked extension, register a single-tenant Entra SPA, and enter
its tenant/client IDs in Options. **[Setup instructions](docs/SETUP.md)** cover
the redirect URI, delegated permissions, admin consent, directory roles and limits.
No client secret is needed.

The implementation follows [the design plan](docs/PLAN.md): strict TypeScript,
esbuild, no UI framework, pure governance classification and Vitest tests.
Inline badges, intermediate nested-group paths and PIM activation remain out of scope.
