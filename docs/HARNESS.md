# Agent harness

A small loop that lets GitHub Copilot agents work through GitHub Issues while the repo
gets better at guiding them. It is based on a few practices that recur in current write-ups on
long-running and self-improving coding agents:

- **Ground truth before anything sticks.** Every change must pass the quality gate
  (`npm run verify`: build, tests, lint, typecheck) locally and in CI. An agent saying
  "done" counts for nothing until the gate passes.
- **Separate roles, different models.** One model implements, a different model reviews in
  read-only mode, and a third pass reflects on the run. A reviewer that did not write the
  code finds different mistakes.
- **Persistent memory in the repo.** Each session starts with no memory. What was learned
  lives in `.agents/LESSONS.md` (candidates) and `AGENTS.md` → _Learned rules_ (promoted),
  both read by every agent.
- **Human-gated self-modification.** The retrospective agent can add lessons, promote
  recurring ones into `AGENTS.md`, and file `harness` issues. All of that lands through the
  run's PR, so a human reviews every change to the instructions. Nothing is auto-merged.
- **Small, scoped tasks with an explicit definition of done.** Issues use the _Agent task_
  form (goal, acceptance criteria, manual checks). Out-of-scope problems become new issues
  (`triage`) instead of growing the change.
- **Measure.** Every run appends one line to `.agents/metrics.jsonl` (attempts, gate failures,
  review findings by severity, lessons added, outcome). If the instructions are improving,
  attempts and high/medium findings per run should trend down.

## The loop

```
GitHub issue (agent:ready)
  └─ implement agent (Copilot CLI, write)        ← AGENTS.md + LESSONS.md + issue
       └─ gate ── fail → fix agent with gate output (up to maxAttempts)
  └─ review agent (different model, read-only)   → JSON findings
       ├─ in-scope high/medium → fix agent → gate
       └─ out-of-scope → new issues (triage, source:agent-review)
  └─ retrospective agent (read-only)             → lessons, promotions, harness issues
  └─ commit → push → PR "Closes #N" (agent:in-review)
     failure at any step → issue comment + agent:needs-human
  └─ Codex review on the PR (GitHub app) + CI          → address comments, fix conflicts
```

Every PR in this repo also gets an automatic **Codex review** (`chatgpt-codex-connector`).
Treat its findings like the review agent's: verify each against the code, fix or reply, and
record anything recurring in `.agents/LESSONS.md`. Stacked PRs need the base branch merged
in whenever it moves, to keep them free of conflicts.

## Usage

One-time setup:

```bash
npm run agent:labels
```

Then file an issue with the **Agent task** form (it gets `agent:ready`) and run, from a
clean working tree:

```bash
npm run agent -- 12
```

To take the oldest `agent:ready` issue instead, use `npm run agent -- --next`. To check the
wiring without calling models or changing GitHub, add `--dry-run`. To override the models
for one run, use `--impl-model <id>` and `--review-model <id>`. The defaults live in
`.agents/harness.config.json`, along with the gate commands and labels.

Requirements: `gh` signed in to the repo's GitHub host, and `copilot` CLI signed in. Model IDs
are the Copilot model picker names, lowercased with hyphens.

### Script-first orchestration and model routing

Claude Code only runs scripts and reads results. Deterministic work (fetching comments,
validation, gates, commits, pushes, replies, and thread resolution) stays in Node scripts.
Judgment goes through `scripts/harness/copilot.mjs`:
`runCopilot({ role, task, prompt, readOnly, dryRun })` resolves the task in
`.agents/harness.config.json` and returns `{ ok, stdout, output }`. The issue harness
also preserves its explicit CLI model overrides (`--retro-model` included).
Prompts and combined stdout/stderr replies are saved as `<role>-prompt.md` and
`<role>-reply.md` under `.agents/tmp/`. Dry runs save these artifacts but never invoke
Copilot. Machine-readable agent results are parsed from stdout only.

| Task              | Model              | Rationale                                              |
| ----------------- | ------------------ | ------------------------------------------------------ |
| `implement`       | `gpt-6.1-sol`      | Implementation and merge-conflict reasoning            |
| `addressComments` | `gpt-6.1-sol`      | Verify findings against code and implement valid fixes |
| `review`          | `claude-opus-5.5`  | Independent, read-only judgment from a different model |
| `retro`           | `claude-opus-5.5`  | Careful synthesis of lessons and recurring rules       |
| `triage`          | `claude-haiku-5.5` | Cheap, quick classification for callers needing triage |

### PR scripts

Run from the repository root, with `gh` authenticated and a clean tree for mutating
workflows. These scripts use plain Node and `gh`, without runtime dependencies:

```bash
npm run pr:comments -- 9
npm run pr:reply -- 9 123456 "Fixed in <sha>"
npm run pr:reply -- 9 123456 "Declined: this behavior is intentional" --no-resolve
npm run pr:address -- 9 --dry-run
npm run pr:address -- 9
npm run pr:sync -- feature-branch base-branch
```

`pr:comments` prints a JSON array of unresolved review threads, paging all GraphQL
`reviewThreads`. Each entry represents the thread's first comment and includes
`threadId`, `commentId` (database ID), `author`, `path`, `line`, and `body`.
Deleted authors and unavailable lines are `null`. `pr:reply` takes that root comment ID,
posts the message with the Claude Code attribution footer, then resolves the thread
unless `--no-resolve` is supplied.

`pr:address` checks out the same-repository PR head (forks are rejected), requires a
clean tree before and after checkout, and gives every unresolved thread to
`addressComments`. The agent must finish with fenced JSON:

```json
{
  "comments": [
    { "commentId": 123, "action": "fixed", "reply": "One-line explanation" }
  ]
}
```

Every input ID must appear exactly once; actions are `fixed` or `declined`, and replies
must be nonempty single lines. Invalid output is retried once, then the script fails
without publishing. The gate is `npm run verify`, with up to two agent fix retries.
Only after it passes does the script commit and push changes, then reply with the
commit SHA and the agent's explanation. Only `fixed` threads are resolved.
An all-declined run without changes replies using the current SHA without an empty
commit or push. Reporting `fixed` without any changes is an error.
Failures leave local changes for inspection but do not publish replies before the push.
Dry-run reads GitHub and saves an ignored prompt/reply preview, but does not check out,
edit code, invoke models, run the gate, commit, push, or reply.

`pr:sync` fetches both branches, switches to the local head branch, requires it to match
its remote head, and merges `origin/<base>` using `--no-commit --no-ff`. A clean merge
is gated and committed before pushing. Conflicted files go to `implement` via the same
runner. The gate can request up to two fixes; if it still fails, the pending merge is
aborted and nothing is pushed. An already-up-to-date branch is gated without agent
fixes. The script leaves the head branch checked out. A push or GitHub reply failure
is reported explicitly; inspect the local commit/posted replies before retrying.

Manual smoke check: `npm run pr:comments -- 9` should print `[]` while all review
threads on PR #9 remain resolved.

### Alternative: Copilot coding agent on GitHub

Assigning an issue to **Copilot** on GitHub also works. It reads
`.github/copilot-instructions.md`, which points it to `AGENTS.md` and `LESSONS.md`. Its
environment comes from `.github/workflows/copilot-setup-steps.yml`, and CI gates its PR.
That path has no review or retrospective step, so add lessons by hand when its PRs need
corrections.

## Labels

| Label                 | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `agent:ready`         | Can be picked up                                                      |
| `agent:in-progress`   | Harness is running                                                    |
| `agent:in-review`     | PR open, waiting for a human                                          |
| `agent:needs-human`   | Harness stopped; see the issue comment and the `agent/issue-N` branch |
| `triage`              | Filed by an agent; accept (relabel `agent:ready`) or close            |
| `source:agent-review` | Out-of-scope defect found by the review agent                         |
| `harness`             | Improvement to the harness itself                                     |
| `needs-tenant-test`   | Only verifiable in a live Entra tenant                                |

## Maintaining the memory

- Prune `.agents/LESSONS.md` when a lesson is wrong or obsolete. Stale rules mislead
  agents more than missing ones.
- Keep `AGENTS.md` short. Promote a lesson only when it recurs.
- Review `.agents/metrics.jsonl` now and then. A rising number of attempts on similar issues
  means the instructions or the issue quality need work. File that as a `harness` issue.
