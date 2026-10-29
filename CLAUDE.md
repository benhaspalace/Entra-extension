# Orchestration

Scripts first. Keep Claude Code to orchestration: run scripts and read their results.
Delegate judgment and code changes to Copilot models through the scripts and shared
harness runner; do not implement, review, or resolve conflicts in the orchestrator.
Follow `AGENTS.md` and `docs/PLAN.md`.

- Issue work: `npm run agent -- <issue>` (or `--next`).
- Inspect unresolved reviews: `npm run pr:comments -- <pr>`.
- Address reviews end-to-end: `npm run pr:address -- <pr>` (`--dry-run` to preview).
- Reply manually: `npm run pr:reply -- <pr> <commentId> "<message>"` (`--no-resolve` to leave open).
- Sync stacked PRs and resolve conflicts: `npm run pr:sync -- <branch> <base>`.
- Quality gate: `npm run verify`.
