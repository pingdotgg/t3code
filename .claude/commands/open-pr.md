---
description: Create a PR end-to-end and actively follow CI and review comments.
argument-hint: <type> <short-description>
---

Open PR workflow: $ARGUMENTS

Use this command after implementation is complete on the task branch and local
validation passes. Cross-check with `.claude/commands/ship.md` before
recommending merge.

GitHub Issues are the live work items. `docs/tasks/*.md` is the durable spec and
execution-log source for non-trivial work. `tasks.md` is only a legacy
compatibility pointer.

Read in this order before running git/gh commands:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.ai/rules/00-constitution.md`
4. `.ai/rules/17-aws-well-architected.md`
5. `.ai/rules/18-pr-readiness.md`
6. `.ai/rules/21-agent-orchestration.md`
7. Linked GitHub issue and `docs/tasks/<task-name>.md` spec, when applicable
8. `.claude/commands/ship.md`

Then execute these steps:

### 1) Confirm branch and worktree

```bash
git status --short --branch
```

Proceed only when one of these is true:

- You are already on the appropriate task branch for the implemented work.
- You are on `main` with no implementation work yet, and the user asked this
  command to create the branch.

If you are on `main` before implementation, create a branch:

```bash
git checkout main
git pull origin main
git checkout -b <type>/<short-description>
# type in: feat | fix | chore | docs | ops | refactor | test | perf
```

Stop and ask before continuing when:

- the current branch is unrelated to the linked issue/spec;
- unrelated dirty changes are present;
- the branch mixes multiple unrelated GitHub issues or durable task specs;
- implementation work exists on `main`;
- the PR would exceed the repo's PR-size policy.

### 2) Confirm SSOT linkage

Before creating a PR, identify the live work item and durable spec:

- GitHub issue number or URL for the work.
- `docs/tasks/<task-name>.md` spec path for non-trivial work, if one exists.
- Phase or acceptance criteria completed by this branch.
- Any follow-up work that remains out of scope for this PR.

If the issue body or GitHub Project `Spec Path` points to a durable spec, read
that spec and verify the execution log reflects this implementation pass. If
the work is issue-only or legacy-numbered, confirm why no durable spec is
needed.

### 3) Validate before commit

```bash
bun check
# Stack A only when API/contracts changed:
bun contracts:check
```

### 4) Commit and push

```bash
git add <specific files>
git commit -m "<type>(scope): concise why-focused message"
git push -u origin HEAD
```

Do not commit unrelated local changes. If there is already a suitable commit on
the branch, do not create an empty commit; push the existing branch instead.

### 5) Create the PR

```bash
gh pr create --base main --title "<type>(scope): short title" --body "$(cat <<'EOF'
## Summary
- ...

## Linked Work
- Closes #...
- Spec: docs/tasks/<task-name>.md

## Testing Guide
1. ...

## Risks and Rollback
- Risk: ...
- Rollback: ...

## Readiness Checklist
- [ ] Relevant Markdown docs updated where needed
- [ ] No documentation impact
- [ ] Tests added or updated for this change
- [ ] No test impact
- [ ] All required CI checks are green
- [ ] GitHub issue linked
- [ ] Durable spec path linked when applicable
- [ ] Task execution log updated when applicable
EOF
)"
```

PR body requirements:

- Explain what changed, why, how to test, risks, and rollback.
- Link the GitHub issue.
- Link the durable spec path when applicable.
- State docs impact and test impact explicitly.
- Keep PR size within policy unless the user approves a larger PR with a clear
  split rationale.

### 6) Follow CI status and PR comments (required)

```bash
# Watch CI until all required checks complete.
gh pr checks --watch --interval 10

# Review comments after CI completes or on each re-run.
gh pr view --comments
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

If comments or CI failures appear:

- Address high-confidence review comments first (bugs, security, regressions).
- Re-run `bun check` (and `bun contracts:check` for Stack A when relevant).
- Push fixes, then repeat CI + comments monitoring until clear.

### 7) Final readiness gate (ship parity)

Before recommending merge, confirm all `ship` checks are satisfied:

- docs impact addressed or explicitly no-impact
- tests impact addressed or explicitly no-impact
- required CI checks green
- PDPL / AR+EN / Well-Architected checks complete
- no unresolved TODOs or blockers
- PR size remains within policy
- GitHub issue and durable spec status are ready for review/merge
- `docs/tasks/<task-name>.md` execution log is current when applicable

Return at the end:

- Branch name
- Commit SHA
- PR URL
- Linked GitHub issue and spec path, if any
- Current required CI status
- Outstanding comment/action list (or `none`)
