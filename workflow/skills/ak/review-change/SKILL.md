---
name: review-change
description: Review a finished diff before it ships. Runs the checks, a simplify pass, a test-quality check, the no-comments pass, a design and architecture scan of structural changes, the harness's own code reviewer, and a check of any performance number it claims, fixing what each finds. Use after a change works and before filing or merging its PR; full-send and maestro-reviewer run it.
---

Run these in sub-agents on the diff against the base branch. Fix what each step finds.

1. **Checks.** Run the project's lint, typecheck, and the tests near the change until they pass. Use the commands the repo documents.
2. **Simplify.** Look for reuse, needless code, and dead code in the diff. Use your harness's built-in simplify skill when it has one (Claude Code: `simplify`). Otherwise do the pass yourself, by the `laziness-protocol` skill.
3. **Tests.** Judge every test the diff adds or changes by the `principle-test-behavior-not-implementation` skill. Rewrite or delete each one that fails it. Then judge the count, by `tdd`'s "Should this test exist?": each new case must name the regression it catches, or it goes; a case that fits an existing test or table becomes a row there; the same check repeated at two layers keeps only the lowest. When the change logged its test seams, flag tests outside them.
4. **Comments.** Run the `no-comments` skill over the diff. When the diff edits docs or a README, run `technical-writing` on those files; when it edits a `SKILL.md`, `AGENTS.md` or `CLAUDE.md`, run `writing-for-agents`.
5. **UI.** Run the `frontend-design` skill if the change involved UI changes.
6. **Code Design.** When the diff adds a module, layer, or abstraction, or touches more than about 5 files:
   - Judge what it adds with the `codebase-design` skill: deep, or a pass-through?
   - Scan the code around it with the [Explore step](../../mattpocock/factory/improve-codebase-architecture/SKILL.md#1-explore) of `improve-codebase-architecture`, in a fresh subagent, scoped to the diff's files and the modules they call instead of the history's hot spots. Leave out its HTML report and grilling. Fix a finding that is small and inside the change's scope. File a bigger one as a ticket the way `to-tickets` writes one, with the finding's files, problem, solution, benefits and strength, the line `From the architecture scan of #<n>.`, and `ready-for-agent` added last. Skip a finding an open issue already covers, and file none when this change came from such a ticket.

   When the diff touches auth or permissions, persistence or migrations, concurrency or event sourcing, wire contracts, a public API, or code that many callers share, run the `blast-radius` skill.

7. **Review.** Run your harness's own code reviewer on the diff (Claude Code: the `code-review` skill). When the change implements an issue or spec, also run only `diff-review`'s Spec sub-agent against the base branch, since its Standards axis repeats steps 1-6; run both axes when the harness has no reviewer you can invoke. When it implements neither, run `replan` in delivered mode against the conversation. When the change or its PR claims a performance number (a speedup, a regression fixed, a latency, a size or a memory figure), vet the measurement with the `benchmark-checklist` skill before accepting it; a number that fails it gets re-measured or comes out of the PR.
8. **Checks again**, if any step above changed code.

Report one line per step: what it found and what you changed.
