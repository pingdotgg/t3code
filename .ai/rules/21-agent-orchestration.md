# 21 — Agent Orchestration

Use this rule when planning, executing, reviewing, opening, shipping, or
resuming agent-assisted work.

## Canonical Lifecycle

`Backlog -> Ready -> In Progress -> In Review -> Done`

- Backlog: issue exists, rough goal known.
- Ready: acceptance criteria, priority, type, stack, compliance, and spec path are known.
- In Progress: implementation branch exists and the issue/project item is assigned.
- In Review: PR exists and links the issue/spec.
- Done: PR merged, issue/project item closed or moved to Done, reusable lessons extracted.

## Command Order

1. `/init-project`
2. `/user-stories <feature> <goal>`
3. `/plan <name> <goal>`
4. `/orchestrate <task-name> [phase-id]` when a coordinator should choose the
   next safe command for a durable plan
5. `/phase <task-name> <phase-id>` for `docs/tasks` plans, or `/execute-task <issue-or-number>` for issue-only/legacy work
6. `/review`
7. `/open-pr <type> <short-description>`
8. Fix CI/review comments or use `.github/ai-loop.yml` when explicitly enabled
9. `/ship <task-name>`
10. `/extract-pr-learnings <pr-number>` when useful

## Source Of Truth

- GitHub Issues: live work items.
- GitHub Projects: live board/status.
- `docs/tasks/*.md`: durable specs and execution logs for non-trivial work.
- `tasks.md`: legacy compatibility pointer only.

Do not remove `docs/tasks` fallbacks from status tooling. Offline agent context
must keep working even when GitHub is unavailable.

## Required GitHub Fields

- `Status`: Backlog, Ready, In Progress, In Review, Done, Blocked
- `Priority`: P0, P1, P2, P3
- `Type`: feature, fix, chore, docs, ops, security, research
- `Stack`: stack-a, stack-b, both, template
- `Compliance`: pdpl, ifrs, security, none
- `Spec Path`: free text path to durable spec

## Agent Rules

- Prefer `/phase` for modern plans under `docs/tasks`.
- Use `/orchestrate` only to coordinate existing lifecycle commands. It must
  not bypass `/phase`, `/review`, `/open-pr`, or `/ship`.
- Use `/execute-task` only for legacy numbered tasks or issue-only work.
- Link every durable spec to a GitHub issue via `github_issue` frontmatter.
- Link every PR to the issue and mention the spec path when one exists.
- Keep issue/project state and the spec execution log consistent.
- If GitHub access is missing, continue only when offline fallback is allowed by the task and report the unavailable integration clearly.
- Stop before enabling `.github/ai-loop.yml` unless legacy workflows are gone,
  `executor_bot_login` is configured, and required secrets are available.
