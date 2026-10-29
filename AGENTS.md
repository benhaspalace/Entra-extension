# Agent instructions

This repo is a Manifest V3 browser extension (Chrome/Edge) for the Microsoft Entra admin
center. The design is in `docs/PLAN.md` — read it first and follow it; do not change the
architecture (side panel + own PKCE sign-in + Graph v1.0) without saying so.

## Rules

- TypeScript strict mode. No `any` unless commented why. No UI framework.
- Keep logic that decides a member's governance source **pure** (in `src/shared/governance.ts`)
  so it can be unit tested without Chrome or network.
- Never log or persist access/refresh tokens outside `chrome.storage.session`.
- Never use `innerHTML` with data from Graph; build DOM with `textContent` / `createElement`.
- Only `https://graph.microsoft.com` and `https://login.microsoftonline.com` may be fetched.
- Content scripts must not read portal storage, cookies or tokens. They may read `location`
  and the shell DOM to inject the menu item / drawer (feature 2), and must never call Graph
  directly — they message the background service worker.
- Injected UI lives in a closed Shadow DOM (drawer) or is a marked clone
  (`data-entra-helper`) of a portal menu item; injection must be idempotent and fail silently.
- Every Graph list call must follow `@odata.nextLink`.
- Add/adjust vitest tests for every pure module.

## Commands

- `npm install`
- `npm run build` → `dist/` (load unpacked from there)
- `npm test`
- `npm run lint`
- `npm run typecheck`

All four must pass before you finish.
