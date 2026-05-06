---
description: Resume a docs/tasks plan through the canonical command lifecycle.
argument-hint: <task-name> [phase-id]
---

Orchestrate: $ARGUMENTS

Use this command to decide and run the next safe command for a durable
`docs/tasks` plan. This is a coordinator runbook only. It delegates to
existing commands and does not replace `/plan`, `/phase`, `/review`,
`/open-pr`, or `/ship`.

Read in this order:

1. `AGENTS.md`
2. `docs/project.md`
3. `review.md`
4. `.cursor/BUGBOT.md`
5. `.ai/rules/00-constitution.md`
6. `.ai/rules/17-aws-well-architected.md`
7. `.ai/rules/18-pr-readiness.md`
8. `.ai/rules/21-agent-orchestration.md`
9. `.ai/rules/01-stack-a-nestjs.md` or `.ai/rules/01-stack-b-convex.md`
   when `docs/project.md` selects a stack
10. `docs/agent-orchestration.md`
11. `.claude/commands/phase.md`
12. `.claude/commands/review.md`
13. `.claude/commands/open-pr.md`
14. `.claude/commands/ship.md`
15. `docs/tasks/<task-name>.md`

Execution rules:

1. Parse `$ARGUMENTS` as `<task-name>` plus an optional `<phase-id>`.
2. If `docs/project.md`, `review.md`, or `.cursor/BUGBOT.md` is still in
   template state, stop and run `/init-project` first unless the task is
   product-agnostic template maintenance.
3. Run `bun run scripts/plan-status.ts <task-name> --github` when GitHub
   access is available. If GitHub is unavailable, run the same command without
   `--github` and report the offline fallback.
4. Select the next phase:
   - If `<phase-id>` was supplied, use it.
   - Otherwise, choose the first phase that is not completed and whose
     dependency text is satisfied by completed earlier phases.
5. Stop before implementation if the chosen phase has unresolved gaps, open
   questions, missing dependency evidence, or an unmerged prerequisite PR.
6. For implementation, invoke the `/phase <task-name> <phase-id>` workflow.
   Follow `.claude/commands/phase.md` exactly and do not continue into another
   phase unless the user explicitly asks.
7. After implementation and local validation, invoke `/review`.
8. If review is clear and the user wants a PR, invoke
   `/open-pr <type> <short-description>`.
9. Monitor CI and PR comments through `/open-pr`. Do not recommend merge until
   required checks are green and actionable comments are addressed.
10. For final pre-merge readiness, invoke `/ship <task-name>`.
11. After merge, update the durable spec execution log and GitHub issue/project
    state. Run `/extract-pr-learnings <pr-number>` when the PR produced
    reusable lessons.

Stop points:

- Uninitialized bootstrap files outside template-maintenance work.
- Missing or ambiguous phase dependencies.
- Open plan questions that affect implementation.
- Dirty working tree with unrelated changes.
- Failed `bun check`, `bun pr:check`, or required CI.
- Open PR review comments or requested changes.
- Any request to enable `.github/ai-loop.yml` while legacy workflows still
  exist or `executor_bot_login`/required secrets are not configured.
- Merge approval. The orchestrator may prepare `/ship` output but must not
  merge unless the user explicitly asks.

Codex-equivalent workflow:

- Codex follows this same runbook manually: inspect plan status, run the
  equivalent shell/GitHub commands, edit files, validate, commit, push, and
  report PR state.
- Codex local authentication is whatever `gh auth status` and local CLI tools
  already provide. Do not write tokens or credentials to the repository.
- No model routing or multi-agent scheduler is implied by this command.

Output format:

- Current plan and selected phase.
- Command chosen next and why.
- Stop points encountered, or `none`.
- Files changed and validation results if implementation ran.
- PR URL and CI/comment status if a PR was opened.
- Next command to run.
