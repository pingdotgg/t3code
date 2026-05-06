---
description: Final pre-merge readiness pass for a planned task.
argument-hint: <task-name>
---

Prepare the task for merge and handoff.

Execution steps:

1. If `docs/project.md` is still in template state, stop and run `/init-project` first.
2. Verify the associated `docs/tasks` spec is complete and current.
3. Verify the GitHub issue and Project item are linked and in `In Review` or
   an equivalent pre-merge state.
4. Run `bun pr:check` if a PR exists; otherwise run `bun check` and report that CI could not be verified.
5. Confirm PR-readiness checklist:
   - [ ] Relevant Markdown docs were updated, or the PR explicitly marks no documentation impact
   - [ ] Tests were added or updated, or the PR explicitly marks no test impact
   - [ ] All required CI checks are green
6. Confirm PDPL checklist:
   - [ ] No real PII in tests, logs, or commits
   - [ ] Arabic privacy strings updated if user-facing text changed
7. Confirm i18n checklist:
   - [ ] AR and EN strings present for every new user-facing string
8. Confirm AWS Well-Architected checklist:
   - [ ] Operational excellence impact and rollback are documented
   - [ ] Security and data handling changes are reviewed
   - [ ] Reliability failure modes are understood
   - [ ] Performance impact is measured or bounded
   - [ ] Cost impact is justified
   - [ ] Sustainability impact is considered
9. Produce a release note style summary:
   - What changed
   - Why it changed
   - Risks and rollback strategy
10. Confirm no unresolved TODOs or blockers.
11. Verify PR ≤ 400 LOC (excluding generated files).
12. If all gates pass, provide a PR title and bullet-point body.
