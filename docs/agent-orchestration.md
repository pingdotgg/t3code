# Agent Orchestration

This is the canonical workflow for agent-assisted work in repos using this
template.

## Source Of Truth

- GitHub Issues are the live work items.
- GitHub Projects is the live status board.
- `docs/tasks/*.md` stores durable specs for non-trivial work.
- `tasks.md` is a legacy compatibility pointer, not the active queue.

Use `docs/tasks/*.md` when work is multi-phase, architectural, compliance-
sensitive, security-sensitive, touches shared workflow/CI, or needs future
agent resumption. Small low-risk changes may live entirely in a GitHub issue.

## Lifecycle

| State       | Command                                                                            | Required update                                                   |
| ----------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Backlog     | `/user-stories`, `/plan`                                                           | issue exists, project item created                                |
| Ready       | `/plan --publish`                                                                  | acceptance criteria, priority, type, stack, compliance, spec path |
| In Progress | `/orchestrate <task> [phase]`, `/phase <task> <phase>`, or `/execute-task <issue>` | issue/project moved to In Progress                                |
| In Review   | `/review`, `/open-pr`                                                              | PR linked from issue, readiness checklist updated                 |
| Done        | `/ship <task>`                                                                     | issue/project moved to Done after merge                           |

## Command Sequence

1. Bootstrap: `/init-project`
   - Skip only for product-agnostic template maintenance.
   - Verify GitHub labels and project fields before non-trivial derived-repo work.
2. Discover: `/user-stories <feature> <goal>`
3. Plan: `/plan <name> <goal>`
   - Creates a local draft, then publishes `docs/tasks/<name>.md` and mirrors it to a GitHub issue when confirmed.
4. Coordinate: `/orchestrate <task-name> [phase-id]`
   - Chooses the next safe command for a durable plan, stops at dependency,
     approval, CI, and PR gates, and delegates implementation to `/phase`.
5. Execute:
   - Use `/phase <task-name> <phase-id>` for `docs/tasks` plans.
   - Use `/execute-task <issue-or-number>` only for issue-only or legacy `tasks.md` work.
6. Review: `/review`
7. Open PR: `/open-pr <type> <short-description>`
8. Fix loop:
   - Address CI/review comments manually, or use the optional `.github/ai-loop.yml` when enabled.
9. Ship: `/ship <task-name>`
10. Learn: `/extract-pr-learnings <pr-number>` when the PR produced reusable lessons.

## GitHub Project Contract

Required project fields:

| Field      | Options                                               |
| ---------- | ----------------------------------------------------- |
| Status     | Backlog, Ready, In Progress, In Review, Done, Blocked |
| Priority   | P0, P1, P2, P3                                        |
| Type       | feature, fix, chore, docs, ops, security, research    |
| Stack      | stack-a, stack-b, both, template                      |
| Compliance | pdpl, ifrs, security, none                            |
| Spec Path  | free text path such as `docs/tasks/example.md`        |

Required labels:

- `plan`
- `needs-triage`
- `type:feature`, `type:fix`, `type:chore`, `type:docs`, `type:ops`, `type:security`
- `stack:a`, `stack:b`, `stack:template`
- `priority:p0`, `priority:p1`, `priority:p2`, `priority:p3`
- `compliance:pdpl`, `compliance:ifrs`, `compliance:security`

## Claude And Codex Mapping

- Claude slash commands are canonical runbooks in `.claude/commands/`.
  Codex-compatible wrappers live in `.codex/commands/` and delegate to the
  same canonical runbooks. When a Codex user invokes `/command ...`, read the
  matching `.codex/commands/command.md` wrapper first. Run `bun codex:sync`
  after command changes; `bun check` runs `bun codex:check` to catch wrapper
  drift.
- `/phase` is the default implementation entrypoint for modern `docs/tasks` plans.
- `/orchestrate` is a coordinator, not a new implementation path. It chooses
  which existing command to run next and stops before merge or loop-enable
  gates unless the user explicitly approves.
- `/execute-task` remains for legacy numbered `tasks.md` work and issue-only work.
- Both agents must update the durable spec execution log when working from a `docs/tasks` plan.
