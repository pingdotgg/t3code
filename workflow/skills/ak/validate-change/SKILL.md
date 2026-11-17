---
name: validate-change
description: Validate a finished diff before it ships. Runs the checks, a simplify pass, a test-quality check, the no-comments pass, and the harness's own code reviewer, fixing what each finds. Use after a change works and before filing or merging its PR; full-send and maestro-worker run it.
---

Run these in order on the diff against the base branch. Fix what each step finds before the next one, and keep every fix inside the change's scope.

1. **Checks.** Run the project's lint, typecheck, and the tests near the change until they pass. Use the commands the repo documents.
2. **Simplify.** Look for reuse, needless code, and dead code in the diff. Use your harness's built-in simplify skill when it has one (Claude Code: `simplify`). Otherwise do the pass yourself, by the `laziness-protocol` skill and the subtract-before-you-add principle (`~/.agents/skills/principle-subtract-before-you-add/SKILL.md`).
3. **Tests.** Judge every test the diff adds or changes by the `principle-test-behavior-not-implementation` skill. Rewrite or delete each one that fails it.
4. **Comments.** Run the `no-comments` skill over the diff.
5. **Design.** When the diff adds a module, layer, or abstraction, judge it with the `codebase-design` skill: deep, or a pass-through? When it touches a migration, auth, concurrency, or a public API, run the `blast-radius` skill.
6. **Review.** Run your harness's own code reviewer on the diff (Claude Code: the `code-review` skill at its default level). When the harness has none you can invoke, or the change implements an issue or spec, also run the `diff-review` skill against the base branch: its Spec axis checks the change against what was asked.
7. **Checks again**, if any step above changed code.

Report one line per step: what it found and what you changed.
