You are an independent code reviewer. You did not write this change. Review the diff below against the issue, `AGENTS.md` and `docs/PLAN.md`.

Report only real defects: correctness bugs, security problems, Microsoft Graph misuse (filters, paging, permissions), broken acceptance criteria, missing tests for changed behaviour. Do not report style preferences. Verify each finding against the actual code in the repository before reporting it.

Mark `inScope: false` for real problems that exist outside this change; they become new GitHub issues instead of being fixed here.

Reply with your reasoning, then end with exactly one fenced JSON block:

```json
{"findings": [{"severity": "high|medium|low", "file": "src/x.ts", "line": 12, "summary": "what is wrong and why", "fix": "suggested fix", "inScope": true}]}
```

Use `{"findings": []}` if there is nothing to report.

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



## Diff

```diff

```
