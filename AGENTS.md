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
- Use generic agent roles in tracked files; keep CLI, model, and review bot identities
  only in the ignored `.agents/harness.local.json` or environment variables.
- Attribute work only to the repository owner; do not add tool credits, reply footers,
  coauthor trailers, or session links to commits, PRs, or comments.

## Commands

- `npm install`
- `npm run build` → `dist/` (load unpacked from there)
- `npm test`
- `npm run lint`
- `npm run typecheck`

All four must pass before you finish (`npm run verify` runs them all).

## Workflow

- Work comes from GitHub Issues labelled `agent:ready`. Keep a change scoped to its issue;
  report unrelated problems instead of fixing them (they become new issues).
- Read `.agents/LESSONS.md` before starting: mistakes earlier agents made here.
- The harness (`npm run agent -- <issue>`, see `docs/HARNESS.md`) runs implement → gate →
  independent review → fix → gate → PR → retrospective.
- Scripts first: the orchestrator only orchestrates; judgment goes to agents through the
  shared harness runner. Use `pr:comments`, `pr:reply`, `pr:address`, and `pr:sync`
  npm scripts for PR reviews and stacked-branch conflicts (see `docs/HARNESS.md`).

## Orchestration

Scripts first. The orchestrator runs scripts and reads their results.
Delegate judgment and code changes to implementation and review agents through the
shared harness runner; do not implement, review, or resolve conflicts in the orchestrator.
Follow `AGENTS.md` and `docs/PLAN.md`.

- Issue work: `npm run agent -- <issue>` (or `--next`).
- Inspect unresolved reviews: `npm run pr:comments -- <pr>`.
- Address reviews end-to-end: `npm run pr:address -- <pr>` (`--dry-run` to preview).
- Reply manually: `npm run pr:reply -- <pr> <commentId> "<message>"` (`--no-resolve` to leave open).
- Sync stacked PRs and resolve conflicts: `npm run pr:sync -- <branch> <base>`.
- Quality gate: `npm run verify`.
- CI parity: `npm run ci` (manifest/version gate, verify, actionlint when installed).
- Request both reviews: `npm run pr:request-review -- <pr>`.
- Merge readiness: `npm run pr:review-check -- <pr>`.

## Trust-surface changes

PRs touching `.github/**`, `AGENTS.md`, `.agents/**`, `scripts/**`, `package.json`,
`package-lock.json`, or `manifest.json` require a clean current-head security review
and are **owner-merge only**. Never auto-merge them. Branch rules and repository
settings must enforce the CI and `review-readiness` status checks; see `docs/HARNESS.md`.

## Learned rules

Promoted from `.agents/LESSONS.md` after recurring in runs. Keep each rule short and checkable.
