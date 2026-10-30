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
- Every Graph call must be covered by a scope in `authScopes()`; reading another user's profile (`/users/{id}`) needs `User.ReadBasic.All`, not `User.Read`. Make non-essential lookups optional so one 403 cannot fail a whole view. _(issue #0, 2026-10-29: automated reviewer on PR #1)_
- Do not edit `scripts/harness/` unless the issue names it. Never delete or loosen an existing test, assertion or `docs/HARNESS.md` paragraph to make a change pass. If an existing test conflicts with the issue, stop and report the conflict. _(issue #17, 2026-10-29: Issue #17: the implementation agent weakened `isReviewResult` in lib.mjs and changed model resolution in agent.mjs. It also added a tool-credit line to the PR body in run.mjs. It deleted the tests in test/harness.test.ts, test/harness-run.test.mjs and agent.test.mjs, plus the HARNESS.md text covering each change. The review agent reported 1 high and 2 medium findings, all in scope.)_
- Localized portal labels used to find or anchor injected UI must match what the actual Entra blade shows (portal language switched, or the portal's own resource strings), and the citing comment must name that source. Do not take labels from translated Microsoft Learn prose, and do not add guessed casing or wording variants. _(issue #4, 2026-10-30: Issue #4: the review agent found that the labels in src/content/menuLabels.ts cited translated Learn how-to pages for tenant-level navigation, not the user-profile blade menu item. It also flagged a guessed lower-case pt-BR duplicate. A mismatched label silently stops the item from being injected for that language.)_
