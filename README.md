# Entra Admin Helper

A Manifest V3 extension for Microsoft Edge / Chrome that explains **direct group
membership** in the Microsoft Entra admin center.

Phase 1 provides a side panel for **Group > Members** and **User > Groups**. It shows
delivered access packages (including multiple package links and expiry), dynamic
rules, AD sync, or manual membership with lazy audit-log attribution. Filter rows
by governance source and open the relevant Entra blades from each row.

The extension uses its own authorization code + PKCE sign-in and Microsoft Graph
v1.0, not portal tokens or DOM scraping. Tenant/client settings sync through the
browser; tokens and a 15-minute package map stay in session storage only.

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
Inline badges, PIM and transitive membership explanations remain out of scope.
