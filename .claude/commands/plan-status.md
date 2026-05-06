---
description: Report current repo-spec progress and linked GitHub tracking state.
argument-hint: [task-name|--all] [--github]
---

Use `$ARGUMENTS` to select a specific task plan by name or `--all`.

Execution rules:

1. Read `AGENTS.md`, `docs/agent-orchestration.md`, and the relevant
   `docs/tasks/*.md` plan files. `tasks.md` is legacy compatibility only.
2. Run `bun run scripts/plan-status.ts $ARGUMENTS` to get the current structured phase snapshot.
3. Inspect `git status --short` and any execution-log entries in the selected plan files before concluding that work is done.
4. Return a markdown table with these columns:
   - `Plan`
   - `GitHub`
   - `Phase`
   - `Status`
   - `Dependencies`
   - `Evidence`
   - `Gaps`
5. Status must be conservative:
   - Use `completed` only when the plan checklist/logs and the codebase both support that conclusion.
   - Use `in-progress` when some work is done but the phase is not finished.
   - Use `not-started` when the checklist is untouched.
   - Use `unknown` when the plan format or repo evidence is insufficient.
6. If dependencies are missing from the plan, say `unspecified` instead of inventing them.
7. Use `--github` only when GitHub access is available and live linked issue
   status is needed. Without it, keep deterministic offline repo-spec status.
8. Highlight gaps clearly after the table. Ask follow-up questions only if a blocking ambiguity remains.

Do not implement code changes in this command.
