# Agent harness

A small loop that lets agents work through GitHub Issues while the repo
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
  └─ implementation agent (agent CLI, write)    ← AGENTS.md + LESSONS.md + issue
       └─ gate ── fail → fix agent with gate output (up to maxAttempts)
  └─ review agent (different model, read-only)   → JSON findings
       ├─ in-scope high/medium → fix agent → gate
       └─ out-of-scope → new issues (triage, source:agent-review)
  └─ retrospective agent (read-only)             → lessons, promotions, harness issues
  └─ commit → push → PR "Closes #N" (agent:in-review)
     failure at any step → issue comment + agent:needs-human
  └─ automated reviewer on the PR + CI           → address comments, fix conflicts
```

PRs can also receive findings from an **automated reviewer**.
Treat its findings like the review agent's: verify each against the code, fix or reply, and
record anything recurring in `.agents/LESSONS.md`. Stacked PRs need the base branch merged
in whenever it moves, to keep them free of conflicts.

## Usage

One-time setup: copy `.agents/harness.local.example.json` to
`.agents/harness.local.json` and replace every placeholder with your local agent CLI
binary name, task model IDs, and automated reviewer's login. The local file is
git-ignored; never commit it. The CLI must be available on `PATH` and signed in.
Only a binary name (not a path or command with arguments) is supported.

Then create the workflow labels:

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
for one run, use `--impl-model <id>` and `--review-model <id>`. Model defaults live only
in the ignored local file; `.agents/harness.config.json` keeps tasks, gate commands,
retry limits, and labels.

Environment variables override local settings: `AGENT_CLI`, `REVIEW_BOT_LOGIN`,
`AGENT_MODEL_IMPLEMENT`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_RETRO`,
`AGENT_MODEL_ADDRESS_COMMENTS`, and `AGENT_MODEL_TRIAGE`. These can also supply settings
without a local file. Missing or invalid settings fail with setup guidance, including
during dry runs. Model IDs must contain only letters, digits, dots, underscores, or
hyphens. Requirements: `gh` signed in to the repo's GitHub host and the agent CLI signed in.
All review authors' threads remain eligible; the configured bot login does not filter
out human reviews.

### Script-first orchestration and model routing

The orchestrator only runs scripts and reads results. Deterministic work (fetching comments,
validation, gates, commits, pushes, replies, and thread resolution) stays in Node scripts.
Judgment goes through `scripts/harness/agent.mjs`:
`runAgent({ role, task, prompt, readOnly, dryRun })` resolves the task using
the local configuration and environment and returns `{ ok, stdout, output }`. The issue harness
also preserves its explicit CLI model overrides (`--retro-model` included).
Prompts and combined stdout/stderr replies are saved as `<role>-prompt.md` and
`<role>-reply.md` under `.agents/tmp/`. Dry runs save these artifacts but never invoke
the agent CLI. Machine-readable agent results are parsed from stdout only.
Metrics record roles rather than model IDs; PR bodies and commits do not identify models.

| Task              | Role                                                   |
| ----------------- | ------------------------------------------------------ |
| `implement`       | Implementation and merge-conflict reasoning            |
| `addressComments` | Verify findings against code and implement valid fixes |
| `review`          | Independent, read-only review using a different model  |
| `retro`           | Retrospective lessons and recurring rules              |
| `triage`          | Classification for callers needing triage              |

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
posts only the supplied message without an attribution footer, then resolves the thread
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
