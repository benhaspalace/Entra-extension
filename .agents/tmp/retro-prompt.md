You are the retrospective agent. Study the run record below (quality-gate failures, review findings, number of attempts) and decide what future agents should learn from it.

Rules:
- A lesson must be a short, specific, checkable instruction that would have prevented a real failure in this run, e.g. "Graph assignment filters support only `eq` on state; filter other states client-side." Not generic advice ("write good tests").
- Do not repeat lessons already in the lessons file or rules already in `AGENTS.md`.
- Propose promoting a lesson into `AGENTS.md` (`promote`) only if the same kind of mistake appears in the existing lessons file **and** again in this run, i.e. it recurs.
- `harnessIssues` are improvements to the harness itself (prompts, gate, scripts, CI) that would have made this run faster or more reliable. Leave them empty unless the run record shows a concrete problem.
- Return empty arrays when the run went smoothly. Fewer, better lessons beat many.

End with exactly one fenced JSON block:

```json
{"lessons": [{"rule": "...", "evidence": "what happened in this run"}], "promote": ["rule text for AGENTS.md"], "harnessIssues": [{"title": "...", "body": "..."}]}
```

## Run record

```json
{
  "date": "2026-10-29",
  "issue": 4,
  "implModel": "gpt-6.1-sol",
  "reviewModel": "claude-opus-5.5",
  "attempts": 1,
  "gateFailures": [],
  "findingCounts": {
    "high": 0,
    "medium": 0,
    "low": 0,
    "followUps": 0
  },
  "lessonsAdded": 0,
  "rulesPromoted": 0,
  "outcome": "unknown",
  "reviewFindings": []
}
```

## Current lessons file

# Lessons from agent runs

Candidate lessons written by the retrospective agent after each harness run (`scripts/harness/run.mjs`).
They are fed to every implementation agent. A lesson that recurs is promoted into `AGENTS.md` → "Learned rules".
Lessons land through the run's PR, so a human reviews every one. Delete lessons that turn out to be wrong.

## Seeded from the first build (2026-10-29)

- Graph `accessPackageAssignment.state` supports only `eq`; never combine states with `or` in `$filter` — filter extra states client-side. _(issue #0, 2026-10-29: fix agent added a multi-state `or` filter)_
- An access package governs group membership only if its resource role is the group's `Member` role (`role.originId` starts with `Member_`); owner roles do not count. _(issue #0, 2026-10-29: found by review agent)_
- Treat `delivered`, `partiallyDelivered` and `delivering` assignments as active; `partiallyDelivered` usually still granted the group. _(issue #0, 2026-10-29: found by review agent)_
- Prefer the documented `$expand` form of a Graph call over undocumented per-item endpoints; check Microsoft Learn before using an endpoint. _(issue #0, 2026-10-29: found by review agent)_
- When changing a Graph query string, update the tests that assert on it in the same change. _(issue #0, 2026-10-29: two data tests asserted the removed filter)_
- Every Graph call must be covered by a scope in `authScopes()`; reading another user's profile (`/users/{id}`) needs `User.ReadBasic.All`, not `User.Read`. Make non-essential lookups optional so one 403 cannot fail a whole view. _(issue #0, 2026-10-29: Codex review on PR #1)_


## Current AGENTS.md

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

All four must pass before you finish (`npm run verify` runs them all).

## Workflow

- Work comes from GitHub Issues labelled `agent:ready`. Keep a change scoped to its issue;
  report unrelated problems instead of fixing them (they become new issues).
- Read `.agents/LESSONS.md` before starting: mistakes earlier agents made here.
- The harness (`npm run agent -- <issue>`, see `docs/HARNESS.md`) runs implement → gate →
  independent review → fix → gate → PR → retrospective.

## Learned rules

Promoted from `.agents/LESSONS.md` after recurring in runs. Keep each rule short and checkable.

