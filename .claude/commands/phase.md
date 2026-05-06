---
description: Implement a single phase from an existing docs/tasks spec and update execution logs.
argument-hint: <task-name> <phase-id>
---

Use `$ARGUMENTS` to identify the task and phase.

Execution rules:

1. If `docs/project.md` is still in template state, stop and run `/init-project` first.
2. Open `docs/tasks/<task-name>.md` and read the full spec.
3. Implement only the requested phase — do not silently scope-creep.
4. If the phase has missing prerequisites, stop and report them.
5. Update the task file after coding:
   - Mark checklist items completed/in-progress.
   - Append an execution log entry with files changed and key decisions.
   - Record any Well-Architected tradeoffs or regressions introduced by the phase.
   - Record any deviations from the plan.
6. Run `bun check` and report results.

If requirements changed, update the plan before continuing.
