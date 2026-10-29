You are the implementation agent for this repository. Work on the GitHub issue below.

1. Read `AGENTS.md` and `docs/PLAN.md` first and follow them. The issue's acceptance criteria define "done".
2. Read the lessons from earlier runs below and avoid repeating those mistakes.
3. Keep the change scoped to this issue. If you notice unrelated problems, do not fix them — list them at the end of your reply under "Out of scope".
4. Add or update unit tests for every behaviour you change.
5. Run the quality gate and fix until it passes: `npm run build && npm test && npm run lint && npm run typecheck`
6. Do not commit, push, or touch GitHub — the harness does that.

End your reply with a short summary of what you changed and anything a reviewer must check by hand.

## Issue

# #4 Support localized portal labels for the user-menu anchor

### Goal
The "Access packages" menu item is anchored by the exact English text "Custom security attributes" (`src/content/menuLabels.ts`). Admins using the portal in another language see no menu item.

### Acceptance criteria
- [ ] `customSecurityAttributeLabels` covers at least de, fr, es, it, nl, pt-BR, ja (from the portal's own strings, cited in a comment).
- [ ] Our own label ("Access packages") is localized from `navigator.language` with English fallback.
- [ ] Unit tests cover a non-English menu fixture.

### Pointers
`src/content/menu.ts`, `test/menu.test.ts`.



## Lessons from earlier runs

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

