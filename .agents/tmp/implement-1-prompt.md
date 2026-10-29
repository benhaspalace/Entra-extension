You are the implementation agent for this repository. Work on the GitHub issue below.

1. Read `AGENTS.md` and `docs/PLAN.md` first and follow them. The issue's acceptance criteria define "done".
2. Read the lessons from earlier runs below and avoid repeating those mistakes.
3. Keep the change scoped to this issue. If you notice unrelated problems, do not fix them — list them at the end of your reply under "Out of scope".
4. Add or update unit tests for every behaviour you change.
5. Run the quality gate and fix until it passes: `npm run build && npm test && npm run lint && npm run typecheck`
6. Do not commit, push, or touch GitHub — the harness does that.

End your reply with a short summary of what you changed and anything a reviewer must check by hand.

## Issue

# #10 Script the PR workflow and route agentic work to Copilot models

### Goal
Minimize agentic work in this repo. The orchestrator (Claude Code) should only run scripts and read their results. Any step that can be deterministic must be a script. Steps that need judgment go to GitHub Copilot CLI models through one shared runner, and the right model is picked per task.

### Acceptance criteria
- [ ] **Shared Copilot runner.** Move the `copilot()` function and the prompt-file handling out of `scripts/harness/run.mjs` into `scripts/harness/copilot.mjs`, and use it from `run.mjs`.
  - Signature: `runCopilot({ role, task, prompt, readOnly, dryRun })`.
  - It resolves the model from `task` via `.agents/harness.config.json` → `models`.
  - It writes prompt and reply files under `.agents/tmp/`.
  - It returns `{ ok, stdout, output }`.
- [ ] **Model routing in `.agents/harness.config.json` `models`.** Add tasks and keep the existing ones:
  - `implement`: `gpt-6.1-sol`
  - `review`: `claude-opus-5.5`
  - `retro`: `claude-opus-5.5`
  - `addressComments`: `gpt-6.1-sol`
  - `triage`: `claude-haiku-5.5` (cheap and quick)
  - Document the routing rationale in `docs/HARNESS.md`.
- [ ] **PR scripts in `scripts/pr/`.** Plain Node, no dependencies, using `gh`. Each is also an npm script.
  - `npm run pr:comments -- <pr>` (`comments.mjs`): prints the PR's **unresolved** review threads as JSON. Use the GraphQL `reviewThreads` with `isResolved`. Each entry has `threadId`, `commentId` (databaseId), `author`, `path`, `line`, `body`.
  - `npm run pr:reply -- <pr> <commentId> <message>` (`reply.mjs`): replies in the thread, appending the footer line `_🤖 Addressed by [Claude Code](https://claude.com/claude-code)_`, then resolves the thread. Supports `--no-resolve`.
  - `npm run pr:address -- <pr>` (`address.mjs`): end-to-end, with no orchestrator judgment needed.
    1. Check out the PR head branch and require a clean tree.
    2. Fetch unresolved threads.
    3. Run the `addressComments` Copilot model with all comments. It verifies each one against the code, fixes the valid ones, and must end with a fenced JSON `{"comments":[{"commentId":123,"action":"fixed|declined","reply":"one line"}]}`. Validate it like `isReviewResult`; on invalid output, retry once and then fail.
    4. Run the gate (`npm run verify`), with up to 2 fix retries through the runner.
    5. Commit and push.
    6. Reply to each thread with the commit SHA and the agent's line. Resolve only the `fixed` threads.
    7. Supports `--dry-run`.
  - `npm run pr:sync -- <branch> <base>` (`sync.mjs`): for stacked PRs. Merges `origin/<base>` into `<branch>`. On a clean merge it runs the gate and pushes. On conflict it hands the conflicted files to the `implement` model through the runner, then runs the gate, commits and pushes. It aborts the merge if the gate still fails.
- [ ] **Unit tests (vitest)** for the pure parts: model resolution, comments JSON shaping from a GraphQL fixture, address-result validation, reply footer formatting.
- [ ] **Project `CLAUDE.md`** at the repo root (short) stating the orchestration rule: scripts first, delegate agentic work to Copilot via the scripts and harness, and keep Claude Code to orchestration. List the npm scripts to use for PR comments, conflicts, and issue work.
- [ ] `AGENTS.md` and `docs/HARNESS.md` mention the new scripts.
- [ ] `npm run verify` passes.

### Pointers
- `scripts/harness/run.mjs` and `lib.mjs` (existing patterns: `run()`, `gh()`, `extractJson`, `isReviewResult`).
- On Windows `copilot` is a `.cmd` shim: spawn with `shell: true` and quote the `-p` argument (see the existing runner).
- GraphQL for threads: `repository.pullRequest.reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId author{login} path line body}}}}`. Resolve with `resolveReviewThread`.

### Manual verification
Run `npm run pr:comments -- 9` against the real PR #9. It should print `[]`, since all threads are resolved.




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
- Every Graph call must be covered by a scope in `authScopes()`; reading another user's profile (`/users/{id}`) needs `User.ReadBasic.All`, not `User.Read`. Make non-essential lookups optional so one 403 cannot fail a whole view. _(issue #0, 2026-10-29: Codex review on PR #1)_

