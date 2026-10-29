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
  lives in `.agents/LESSONS.md` (candidates) and `AGENTS.md` → *Learned rules* (promoted),
  both read by every agent.
- **Human-gated self-modification.** The retrospective agent can add lessons, promote
  recurring ones into `AGENTS.md`, and file `harness` issues. All of that lands through the
  run's PR, so a human reviews every change to the instructions. Nothing is auto-merged.
- **Small, scoped tasks with an explicit definition of done.** Issues use the *Agent task*
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
```

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

### Alternative: Copilot coding agent on GitHub

Assigning an issue to **Copilot** on GitHub also works. It reads
`.github/copilot-instructions.md`, which points it to `AGENTS.md` and `LESSONS.md`. Its
environment comes from `.github/workflows/copilot-setup-steps.yml`, and CI gates its PR.
That path has no review or retrospective step, so add lessons by hand when its PRs need
corrections.

## Labels

| Label | Meaning |
|---|---|
| `agent:ready` | Can be picked up |
| `agent:in-progress` | Harness is running |
| `agent:in-review` | PR open, waiting for a human |
| `agent:needs-human` | Harness stopped; see the issue comment and the `agent/issue-N` branch |
| `triage` | Filed by an agent; accept (relabel `agent:ready`) or close |
| `source:agent-review` | Out-of-scope defect found by the review agent |
| `harness` | Improvement to the harness itself |
| `needs-tenant-test` | Only verifiable in a live Entra tenant |

## Maintaining the memory

- Prune `.agents/LESSONS.md` when a lesson is wrong or obsolete. Stale rules mislead
  agents more than missing ones.
- Keep `AGENTS.md` short. Promote a lesson only when it recurs.
- Review `.agents/metrics.jsonl` now and then. A rising number of attempts on similar issues
  means the instructions or the issue quality need work. File that as a `harness` issue.
