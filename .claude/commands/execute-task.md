---
description: Execute an issue-only or legacy numbered task end-to-end.
argument-hint: <issue-url|issue-number|task-number> [optional details]
---

Execute Task: $ARGUMENTS

Read in this order before touching any code:

1. GitHub issue or URL from `$ARGUMENTS`; if `$ARGUMENTS` is a legacy number,
   read `tasks.md` as a compatibility shim.
2. Linked `docs/tasks/*.md` spec if the issue body or `Spec Path` field names one.
3. `AGENTS.md` — commands and gotchas
4. `.ai/rules/00-constitution.md` — non-negotiables
5. `.ai/rules/17-aws-well-architected.md` — mandatory architecture and review lens
6. `.ai/rules/18-pr-readiness.md` — mandatory docs, tests, and CI gates
7. `.ai/rules/21-agent-orchestration.md` — lifecycle and GitHub linkage rules
8. Stack rule: `.ai/rules/01-stack-a-nestjs.md` or `.ai/rules/01-stack-b-convex.md`
9. Task-relevant rule files from `.ai/README.md`

If the work has a `docs/tasks` durable spec, prefer
`/phase <task-name> <phase-id>` instead of this command.

Then execute these steps exactly:

Bootstrap gate:

- If `docs/project.md` is still in template state (for example `YOUR_PRODUCT_NAME`, `YOUR_APP_NAME`, unchecked stack choice, or placeholder user text), stop and run `/init-project` before branching or coding.

### 1. Branching

```bash
git checkout main && git pull origin main
git checkout -b <type>/issue-<n>-<short-description>
# Types: feat/ fix/ chore/ docs/ ops/
```

Before branching for non-template-maintenance work, run:

```bash
bun preflight --json
```

Abort before branching if any preflight check returns `error`. Warnings should
be summarized in the task notes but do not block by themselves.

### 2. Definition of Ready gate

Confirm before coding:

- [ ] `docs/project.md` is initialized for this repo
- [ ] Goal is clear
- [ ] Happy path and edge cases are defined
- [ ] API/data model references are known
- [ ] Acceptance criteria exist
- [ ] GitHub issue and project fields are ready (`Status`, `Priority`, `Type`, `Stack`, `Compliance`, `Spec Path`)
- [ ] Well-Architected pillar impacts and tradeoffs are understood
- [ ] PR-readiness expectations for docs, tests, and CI are understood

### 3. Implementation

- Write failing tests first (TDD)
- Code only what the task requires — no scope creep
- Fix TypeScript errors as you go

### 4. Validation

```bash
bun check           # types + lint + tests — must pass
bun contracts:check # Stack A only — if API changed
```

### 5. Commit & push

```bash
git add <specific files>  # never git add -A blindly
git commit -m "feat(scope): description"
git push origin <branch>
```

### 6. PR (via gh CLI)

```bash
gh pr create \
  --title "<type>(scope): description" \
  --body "## Summary\n...\n\n## Testing Guide\n...\n\n## Risks\n..." \
  --base main
```

PR body must include: what changed, why, how to test (step by step), risks/mitigations.
PR body must also capture docs impact, test impact, and CI readiness using the
repo template checklist.
PR ≤ 400 LOC excluding generated files.

### 7. Follow-ups

If issues remain: `gh issue create --title "..." --body "..."`

Return at the end:

- Task number and scope
- GitHub issue URL and linked spec path, if any
- Branch name
- Files changed (summary)
- Validation status (PASS / FAIL with output)
- Well-Architected tradeoffs noted
- PR URL
- Follow-up issue URLs or "none"
