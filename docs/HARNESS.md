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
GitHub issue (agent:ready + human approval of exact input digest)
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
Executable lookup ignores empty/relative PATH entries and repository-local paths
(including npm's `node_modules/.bin`), and rejects symlinks back into the repository.
Install the CLI outside the checkout.

Then create the workflow labels:

```bash
npm run agent:labels
```

Then file an issue with the **Agent task** form (it gets `triage`). From a clean working
tree, save a preview of the complete issue input:

```bash
npm run agent -- 12 --dry-run
```

Review `.agents/tmp/issue-12-input.json` in full, including every comment. The harness
prints `agent:approve sha256:<digest>` for those exact bytes. A human with current
repository write, maintain, or admin access must post that exact single-line comment
on the issue, then apply `agent:ready` for automatic selection. Run:

```bash
npm run agent -- 12
```

To take the oldest `agent:ready` issue instead, use `npm run agent -- --next`. The label
alone never authorizes execution, including when an issue number is supplied explicitly.
The harness fetches all comment pages, hashes the issue URL, number, title, body, and
comment IDs/authors/bodies, and verifies a matching approval author's current repository
permission before switching branches, changing labels, or invoking any agent. Bots and
read/triage-only users cannot approve. Standalone approval commands are control metadata,
not prompt content; all other comments are part of the snapshot. Edits, additions, or
deletions invalidate approval if they change the snapshot. Agents receive the frozen
snapshot from that fetch, not a later refetch of mutable issue text. An unapproved
`--next` candidate stops the run rather than being silently skipped.

Dry runs can preview unapproved input without calling models or changing GitHub.
To override the models for one run, use `--impl-model <id>` and `--review-model <id>`.
Model defaults live only
in the ignored local file; `.agents/harness.config.json` keeps tasks, gate commands,
retry limits, and labels.

Per-run overrides (`--impl-model`, `--review-model`, and `--retro-model`) work even
when the corresponding task has no configured model. Overrides must still be valid
model IDs for known tasks; only tasks without an override resolve their configured model.

Environment variables override local settings: `AGENT_CLI`, `REVIEW_BOT_LOGIN`,
`AGENT_MODEL_IMPLEMENT`, `AGENT_MODEL_REVIEW`, `AGENT_MODEL_RETRO`,
`AGENT_MODEL_ADDRESS_COMMENTS`, and `AGENT_MODEL_TRIAGE`. These can also supply settings
without a local file. Missing or invalid settings fail with setup guidance, including
during dry runs. An explicit per-run model override replaces the task default, which
need not be configured or valid when unused; the selected model and task are still
validated. Model IDs must contain only letters, digits, dots, underscores, or
hyphens. Requirements: `gh` signed in to the repo's GitHub host and the agent CLI signed in.
All review authors' threads remain eligible; the configured bot login does not filter
out human reviews.

### Execution trust boundary

Approval is a human trust decision, not a prompt-injection detector or sandbox. Never
approve a digest without reviewing the exact saved snapshot, and do not approve
instructions that ask an agent to retrieve additional unreviewed issue text. Untrusted
issue authors and commenters cannot authorize execution merely by applying labels,
claiming to be a maintainer in their text, or copying another snapshot's approval.

The shared runner still executes write agents with host tool access. It does **not**
provide secret isolation or network confinement. Run it only in a disposable,
secretless environment with independently enforced network restrictions; do not expose
maintainer credentials or unrelated workspaces to the write agent. Authentication for
the agent service and the orchestrator's GitHub operations must be handled by the
environment without granting the write agent reusable maintainer credentials.
Do not treat passing gates or later PR review as protection against tool execution.

Start PR workflows from a reviewed, trusted revision of the orchestrator and its
imported modules, never by launching scripts from an unreviewed PR checkout. The
orchestrator and fixed PR gate definition are loaded before checkout/merge; changing
branch files does not reload them. Write agents still require the externally isolated
environment described above.

Before PR checkout or merge, the workflow snapshots agent configuration and resolves
the CLI to an absolute executable outside the repository. All conflict, review-address,
and gate-fix calls reuse that runner without rereading branch configuration or searching
PATH again. Even a clean sync requires this trusted CLI setup. Tracked
`.agents/harness.local.json`, `.agents/tmp`, and `node_modules` files are rejected,
including on incoming sync branches, after PR checkout, and before agent/gate execution.
Ignored runtime files must remain local, never force-added to a branch.

PR quality gates additionally run branch code only in disposable Linux Docker
containers. `PR_GATE_IMAGE` overrides `prGateImage` in the ignored local configuration.
Set either to a trusted local image ID (`sha256:<64 hex digits>`)
or repository digest (`name@sha256:<64 hex digits>`). Tags are rejected and images
are never pulled by the workflow. The image must be secretless, provide `/bin/sh`,
`cp`, `mkdir`, `ln`, Node >=22.12, and the project's preinstalled Linux dependencies at
`/opt/node_modules`, readable by UID/GID 65534. Provision it from a reviewed, trusted
revision of these scripts and Dockerfile, never from an unreviewed PR checkout:

```bash
npm run gate:image
npm run gate:image -- --ref <trusted-ref-with-lockfile>
```

The default ref is `origin/main`; fetch it separately if needed. The script resolves
the ref to a commit and reads **both** manifests using `git show`, never from working
files. A missing lockfile fails with `--ref` guidance. It pulls `node:22-bookworm-slim`,
inspects its repository digest, and builds `docker/gate.Dockerfile` using that immutable
base and only the trusted manifests in a temporary build context. Dependencies are
installed with `npm ci --ignore-scripts --no-audit --no-fund` under `/opt`; install
lifecycle scripts are disabled. The resulting `sha256:...` image ID is printed and
saved as local `prGateImage`, preserving other settings. Local `prGateImageSource`
records the trusted commit and Node base digest; the commit is also an image label.
Provisioning needs Docker with Linux containers and may need network access; gate
execution never has network access or pulls images. Rebuild when trusted dependencies
change. Only provision refs whose manifests and dependencies you trust.

The gate has no network, host credentials, Git metadata, host dependency mount, or
writable host mount. It receives a read-only temporary snapshot of tracked and
non-ignored new files (including agent edits), excluding local agent configuration,
agent artifacts, `.env` files, and dependencies. Keep secrets out of source files.
Symlinks and non-regular input files are rejected. The container runs unprivileged,
with dropped capabilities, no-new-privileges, a read-only root, resource limits, and
temporary writable workspace storage; its source snapshot is removed afterward.
The workspace has a real, writable `node_modules` directory on tmpfs with links to
each top-level package or scope in the read-only `/opt/node_modules`. This keeps
Vitest/Vite caches (including `node_modules/.vitest-cache` and `node_modules/.vite`)
writable without copying dependencies or making image packages writable. Node
resolves linked tools and their imports from `/opt`; workspace build and test
imports, ESLint configuration imports, and TypeScript's module and implicit
`@types` lookup still find dependencies through `/workspace/node_modules`.
The trusted gate directly runs build, tests, lint, and typecheck, rather than a PR's
mutable `package.json` verification command. The orchestrator runs the local text
policy using trusted code on the host. Missing images, Docker, or prerequisites
fail closed: there is no host-execution fallback. This container boundary protects
gate execution only, not the write agent.

### Local text policy

Set `forbiddenTerms` in the ignored `.agents/harness.local.json` to the owner's
private list (replace the example's `["<term>"]`, or use `[]` for no restrictions).
Matching uses literal, case-insensitive substrings, not regular expressions or
whole words. Never put the real list in tracked files.
The harness checks agent results, lessons/rules, issue text, PR text, and commit
messages before publishing. A match stops the issue run with `agent:needs-human`
and a neutral comment that does not repeat the rejected text. PR replies are
checked before any review-address commit or reply; the shared GitHub/git boundary
also checks outbound text and commit contents.

`npm run check:terms` checks both staged blobs and tracked working files, including
files whose staged and working versions differ. Commits and pushes from the scripts
run the same check. It is also part of `npm run verify`; without a local list
(including in CI) it is a no-op and needs no agent CLI/model configuration.
Errors name the affected label/file and matching term locally, never in the
neutral policy-stop comment. This is a script guard, not an installed Git hook:
run `npm run check:terms` before manual commits too.
Before matching, environment paths (repository root, user home, and OS temporary
directory) are replaced with `<repo>`, `<home>`, and `<tmp>`, longest path first.
Matching is case-insensitive and accepts either slash direction. Gate output is
redacted before checks and before being included in prompts, metrics, or comments,
so checkout-directory names do not trigger the policy.

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
Metrics record roles rather than model IDs; PR bodies, commits, and follow-up issue bodies
contain no tool credits. Follow-up issues retain a reference to the originating issue.
Review results must contain a findings array, with a supported severity and a nonempty
summary for every finding. Optional file/fix fields must be strings, line numbers positive
integers, and scope flags booleans. Any malformed finding invalidates the entire review:
the harness retries once, then stops as unreviewed rather than silently dropping defects.

Review results must contain a `findings` array. Each finding must have a severity
of `high`, `medium`, or `low` and a nonempty string `summary`. Optional `file` and
`fix` fields must be strings, `line` must be a positive integer, and `inScope`
must be a boolean. Invalid results are retried once, then the run stops as
unreviewed without committing, pushing, or opening a PR; malformed findings are
never treated as a clean review.

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
npm run pr:request-review -- 9
npm run pr:review-check -- 9
```

`pr:comments` prints a JSON array of unresolved review threads, paging all GraphQL
`reviewThreads` and all pages of comments within each thread. Each entry represents
the thread's first comment and includes
`threadId`, `commentId` (from GraphQL `fullDatabaseId`, normalized to a positive safe
JavaScript integer), `author`, `authorType`, `path`, `line`, and `body`, plus `comments`
containing the same comment fields for every comment, including replies. `authorType`
is GitHub's verified GraphQL `__typename`, not a claim in the comment text.
IDs beyond JavaScript's safe
integer range are rejected rather than rounded.
Deleted authors and unavailable lines are `null`. `pr:reply` takes that root comment ID,
posts only the supplied message without an attribution footer, then resolves the thread
unless `--no-resolve` is supplied.

`pr:address` automatically includes a thread only when **every** comment is from
either the configured `reviewBotLogin` (`REVIEW_BOT_LOGIN` overrides local config)
verified by GitHub as a Bot, or a User with current repository write, maintain,
or admin permission. The configured login is validated before classification and
compared case-insensitively, accepting either the GraphQL bot login or its REST-style
`[bot]` suffix. A matching login with a User type does not establish bot trust;
it must independently have write access. Permissions are fetched from the collaborator
permission endpoint and cached per login for the run, including approval checks.
Only User authors enter permission lookup; other bots, deleted authors, unknown author
types, and read/triage-only accounts are untrusted. Mixed threads are
untrusted if even one comment is untrusted. These checks do not filter out trusted
human reviews or require approval for verified configured-bot reviews.

When untrusted threads exist, `pr:address` (including `--dry-run`) saves
`.agents/tmp/pr-<pr>-input.json` and prints `agent:approve sha256:<digest>`.
Review the entire saved snapshot, then have a human
with current repository write, maintain, or admin access post that exact single-line
command as a PR conversation comment. The digest covers repository, PR number,
head branch and SHA, and **only the untrusted unresolved threads**, including every
comment's ID, author/type, path, line, and body. Changes to trusted threads do not
change this digest; untrusted thread edits, additions, removals, replies, or a changed
PR head invalidate approval. All approval comment pages are fetched and the approving human's current
repository permission is checked; bots and read/triage-only accounts cannot approve.
Untrusted threads are included only after a matching approval is found, before checkout
or write-agent execution, including retries. Otherwise they are explicitly excluded
while trusted threads proceed. If only unapproved untrusted threads remain, the script
prints a clear message and exits successfully without checkout, agents, gates, or
publication. The frozen selected threads, not a later refetch, are passed to the agent.
Dry-run previews all unresolved threads (including unapproved input) without executing
them, and does not check for approvals. All-trusted runs need no approval snapshot.

`pr:address` checks out the selected same-repository PR head (forks are rejected),
requires a clean tree before and after checkout, and gives every trusted or approved unresolved
thread to `addressComments`. The agent must finish with fenced JSON:

```json
{
  "comments": [
    { "commentId": 123, "action": "fixed", "reply": "One-line explanation" }
  ]
}
```

Every input ID must appear exactly once; actions are `fixed`, `partial`, or `declined`, and replies
must be nonempty single lines. Invalid output is retried once, then the script fails
without publishing. The gate is the isolated PR gate described above (the build,
tests, lint, typecheck, and local text-policy checks), with up to two agent fix retries.
Only after it passes does the script commit and push changes, request fresh reviews,
then reply with
`Fixed in <sha7>: <what changed>. <test added>.`,
`Partly fixed in <sha7>: ...`, or `Declined: <reason, citing the decision/issue>.`
The agent supplies the explanation, test description, or cited reason, not the prefix.
Only `fixed` threads are resolved; partial and declined threads stay open.
Declines are listed in the run summary for the owner.
An all-declined run without changes replies without an empty commit or push.
Reporting `fixed` or `partial` without any changes is an error.
Failures leave local changes for inspection but do not publish replies before the push.
Dry-run reads GitHub and saves an ignored prompt/reply preview, but does not check out,
edit code, invoke models, run the gate, commit, push, or reply.

`pr:sync` fetches both branches, switches to the local head branch, requires it to match
its remote head, and merges `origin/<base>` using `--no-commit --no-ff`. A clean merge
is gated and committed before pushing. Conflicted files go to `implement` via the same
runner. Path-free staging preserves deletions already resolved with `git rm`.
The isolated PR gate can request up to two fixes; if it still fails, the pending merge is
aborted and nothing is pushed. An already-up-to-date branch is gated without agent
fixes, push, or new review request. The script leaves the head branch checked out. A push or GitHub reply failure
is reported explicitly; inspect the local commit/posted replies before retrying.

Manual smoke check: `npm run pr:comments -- 9` should print `[]` while all review
threads on PR #9 remain resolved.

### Automated review protocol

Configure `reviewTriggers` in the ignored local configuration as exactly two distinct
single-line strings: code review, then security review. Configure `reviewStateMarker`
to match the reviewer's hidden JSON marker. `REVIEW_TRIGGERS` (JSON array) and
`REVIEW_STATE_MARKER` override these fields. The reviewer must be configured to
review automatically only on PR opening/ready-for-review, not on push.
`pr:request-review` posts both configured triggers with current-head request metadata.
These explicit trusted control messages bypass the prose text policy, narrowly in
that command; arbitrary replies still pass the normal policy.
`pr:address` and `pr:sync` freeze this configuration before checkout/merge and request
both reviews after a head-changing push, never for a no-op.
After a push, review requests wait up to 30 seconds with backoff for GitHub's PR
head to catch up. A head other than the previous or pushed SHA fails immediately;
a timeout also fails without posting review triggers.

The parser uses this explicit JSON contract (replace `configured-marker` with the
local marker and `<sha40>` with the full lowercase head SHA). Unknown or malformed
trusted state fails closed; ordinary prose saying "clean" is not a receipt.

```text
<!-- configured-marker:request {"headSha":"<sha40>","kind":"code"} -->
<!-- configured-marker {"headSha":"<sha40>","reviews":{"code":{"status":"completed","clean":true,"requestId":101},"security":{"status":"completed","clean":true,"requestId":102}}} -->
<!-- configured-marker:receipt {"headSha":"<sha40>","kind":"code","status":"completed","clean":true,"requestId":101} -->
<!-- configured-marker:receipt {"headSha":"<sha40>","kind":"security","status":"completed","clean":true,"requestId":102} -->
```

Request markers follow their configured trigger separated by a blank line. The IDs
are the GitHub conversation-comment IDs of those requests. Only User requests from
the repository owner or current write/maintain/admin collaborators count. A newer
authorized request invalidates earlier receipts even on the same head.
Automatic opening reviews use `requestId: null` when there is no explicit request.
Summary entries may be `pending`, `running`, or `failed`, but only `completed` with
a boolean `clean` and matching receipt can pass. Summary and receipt authors must
match the configured login **and** verified Bot type; matching text/logins alone
are insufficient. The latest summary is authoritative, including a stale summary.
If the review service's schema differs, update the adapter and fixtures before
requiring the check; do not infer completion from unstructured text.

`pr:review-check` exits **0** only when both current-head reviews have completed,
every reviewer inline finding (including resolved threads) has a nonempty User
reply, and GitHub reports an open, non-draft, mergeable PR. It exits **1** with
reasons while pending, or **3** for owner/manual review at 30 minutes from an
authorized incomplete request, or when the same normalized first-line title and
file recur after a reply. All thread/comment/file pages are fetched. Security must
also be clean for trust-surface changes, including renames away from those paths.
Do not treat a declined thread as resolved or a pending check as success.

The Review readiness workflow runs trusted default-branch scripts, never PR code,
on PR changes and conversation-comment updates, and publishes `review-readiness`
on the checked head. It needs no dependency installation or agent service credentials.
Set repository variables `REVIEW_BOT_LOGIN`, `REVIEW_TRIGGERS`, and
`REVIEW_STATE_MARKER` to the corresponding local values. After inline-only replies
or to refresh a timeout, dispatch the workflow with the PR number (or add a PR
conversation comment). No polling/review-on-push automation is enabled.

### CI and releases

`npm run ci` is the single local/CI validation entry point: manifest version and
permission-decision checks, `verify`, then actionlint. A missing actionlint is an
explicit local skip, never a CI skip. CI installs v1.7.7 after checking its pinned
SHA256. Set `ACTIONLINT` to an installed executable when it is not on PATH.
ShellCheck and pyflakes integrations are disabled for reproducible actionlint
results across developer machines; actionlint itself remains required in CI.
Full Git history and tags are required for permission comparisons.
The first release is compared with an empty baseline; current-commit tags are
excluded so a release cannot approve its own permission additions.
Document exact grant additions and CSP changes in `docs/permissions-decisions.md`.

All workflow actions use full commit pins with version comments, read-only default
permissions, job timeouts, and credential-free checkout. CI/security checks use
disposable hosted runners, including for forks, rather than executing PR code on
a persistent self-hosted runner. Weekly dependency updates are grouped by ecosystem.

Push a `v<package-version>` tag, or dispatch Release **on an existing matching tag**.
The build job runs `npm ci`, `npm run ci`, and `npm run package`. Packaging writes
`release/extension-<version>.zip` (dist contents at the ZIP root) and `SHA256SUMS`.
The build job exposes its run/attempt-specific artifact name as an output. The
protected publish job downloads that exact artifact even when only publish is
retried, checks its checksum, then attaches it to the tag's GitHub release,
replacing existing assets so partial uploads can be retried. It never checks out
or rebuilds source. Release runs never cancel one another. Store API steps are clearly marked
placeholders, not claims that a store upload happened.

Owner setup (not performed by scripts):

- Configure `store-publish` with required reviewers and restrict deployment to release tags.
- Enable secret scanning and push protection in repository settings.
- Require CI and `review-readiness` in a `main` branch ruleset; also require the security scanning jobs as appropriate.
- Enforce owner-only merges for trust-surface PRs (`.github/**`, `AGENTS.md`, `.agents/**`,
  `scripts/**`, `package.json`, `package-lock.json`, `manifest.json`). Never auto-merge these.
- Verify the review service emits the configured marker/receipt contract and only auto-runs on opening/ready.
- Provision Chrome Web Store/Edge Add-ons credentials and replace placeholders only after owner review.

## Labels

| Label                 | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `agent:ready`         | Selection candidate; matching human snapshot approval also required   |
| `agent:in-progress`   | Harness is running                                                    |
| `agent:in-review`     | PR open, waiting for a human                                          |
| `agent:needs-human`   | Harness stopped; see the issue comment and the `agent/issue-N` branch |
| `triage`              | New task or follow-up; review and approve its snapshot, or close      |
| `source:agent-review` | Out-of-scope defect found by the review agent                         |
| `harness`             | Improvement to the harness itself                                     |
| `needs-tenant-test`   | Only verifiable in a live Entra tenant                                |

## Maintaining the memory

- Prune `.agents/LESSONS.md` when a lesson is wrong or obsolete. Stale rules mislead
  agents more than missing ones.
- Keep `AGENTS.md` short. Promote a lesson only when it recurs.
- Review `.agents/metrics.jsonl` now and then. A rising number of attempts on similar issues
  means the instructions or the issue quality need work. File that as a `harness` issue.
