This is the Effect library repository, focusing on functional programming patterns and effect systems in TypeScript.

## Overview

- The git base branch is `main`.
- Use `pnpm` as the package manager.
- Keep changes focused and follow established patterns in the repository.
- Before writing code, read the relevant files in `./.patterns/` and inspect similar existing code.

## Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Workflow

1. Inspect nearby implementation, tests, and pattern docs before editing.
2. Prefer existing abstractions and conventions over introducing new ones.
3. For ad hoc runnable code, create a temporary file in `scratchpad/`, run it with `node scratchpad/<file>.ts`, and delete it when done.
   The local runtime is Node 24, which can run TypeScript files directly; use plain `node` for local TypeScript probes instead of `tsx` unless `node` fails.
4. Run the validation appropriate to the change type.
5. Report which validation commands were run and any commands that could not be run.

## Validation

Use the narrowest validation that still covers the change:

| Change type                 | Validation                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Code changes                | `pnpm lint-fix`, targeted `pnpm test <test_file.ts>`, `pnpm check:tsgo`                                     |
| Tests-only changes          | `pnpm lint-fix`, targeted `pnpm test <test_file.ts>`, `pnpm check:tsgo`                                     |
| Type-level/API type changes | Targeted `pnpm test-types <filename>`, plus `pnpm check:tsgo` when source types changed                     |
| JSDoc/example changes       | From the changed package directory, run `pnpm docgen`; also run `pnpm check:tsgo` when source types changed |
| Docs-only changes           | `pnpm lint-fix`; no tests required unless examples or code changed                                          |

## Coding Patterns

Read `.patterns/effect.md` before changing Effect code. In particular:

- Prefer `Effect.fnUntraced` over functions that only return `Effect.gen`.
- Prefer class syntax for `Context.Service`.
- Do not use `async` / `await` or `try` / `catch`; use Effect APIs such as `Effect.gen`, `Effect.fnUntraced`, and `Effect.tryPromise`.
- Do not use `Date.now` or `new Date`; use `Clock`, and use `TestClock` in tests.

## Testing

Read `.patterns/testing.md` before writing or changing tests.

- Test files are located in `packages/*/test/`.
- Main Effect library tests are in `packages/effect/test/`.
- Use `it.effect` for Effect-returning tests.
- Use regular `it` for pure synchronous tests.
- Do not use `Effect.runSync` in tests.
- Do not use `expect` from Vitest; use `assert` from `@effect/vitest`.
- Type-level tests are in `packages/*/typetest/` and run with `pnpm test-types <filename>`.

## Documentation

- For AI documentation, read `ai-docs/README.md` very carefully before writing examples.
- AI documentation changes may include explanatory comments when useful.
- For public JSDoc `@category` guidance, read `.patterns/jsdoc.md`.
- When JSDoc examples are localized to a single package, run `pnpm docgen` from that package directory instead of the repository root.

## Generated Files

Do not hand-edit generated files. Run the appropriate generator instead.

- `index.ts` barrel files are generated; run `pnpm codegen` after adding or removing modules.

## Changesets

Create a changeset in `.changeset/` for runtime behavior changes or exported type/API changes:

```md
---
"package-name": patch/minor/major
---

A description of the change.
```

Tests-only changes, internal refactors, docs-only changes, and JSDoc-only maintenance may skip changesets by maintainer decision.
