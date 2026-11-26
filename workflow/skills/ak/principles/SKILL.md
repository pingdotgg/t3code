---
name: principles
description: Index of the engineering principles, grouped by stage (plan, build, debug, review, measure, meta), each with when it applies and where to read it. Read your stage's group before non-trivial work, and open a principle in full only when its situation comes up. Maestro workers, reviewers, wayfinder and to-tickets read it.
---

# Principles

Each principle is a skill at `~/.agents/skills/principle-<name>/SKILL.md`. Most are hidden from the skill list, so open them by path. Read your stage's group below, and open a principle in full only when its situation comes up. When a principle changes a decision, name it where the decision is recorded (under `maestro`: the `maestro: decided` comment), with the choice it changed.

## Plan

For charting, specs and tickets: `wayfinder`, `to-spec`, `to-tickets`.

- **foundational-thinking**: before writing logic, choose the core types and data structures, sequence scaffold before features, and ask what concurrent actors share.
- **redesign-from-first-principles**: a new requirement lands on an existing design. Redesign as if it had been there from day one, instead of bolting it on.
- **outcome-oriented-execution**: a planned rewrite or migration with phases. Converge on the target, without throwaway compatibility states.
- **experience-first**: a product, UX or scope tradeoff. Choose user delight over implementation convenience, fewer polished features over more rough ones.
- **build-the-lever**: any non-trivial work. Build the tool that does or proves it (codemod, script, generator) instead of working by hand.
- **sequence-verifiable-units**: multi-step work, and how commits and PRs stack. Small units that each end in a check, verified before the next.

## Build

For the builder (`maestro-worker`), and anyone writing code.

- **laziness-protocol**: tempted to add an abstraction, a layer or signal threading, or sizing a diff. Bias to deletion and the smallest change that works.
- **model-the-domain**: stateful logic, heavy branching, or one shape assumption repeated across files. Encode the domain in a structure, not scattered conditionals.
- **type-system-discipline**: designing types or a signature. Make illegal states unrepresentable, parse external data at boundaries, exhaust variants.
- **boundary-discipline**: wiring validation, error handling or a framework adapter. Guards at system boundaries; trust internal types; keep business logic pure.
- **make-operations-idempotent**: commands, lifecycle steps or loops that run amid crashes and retries. Converge to the same end state however far a prior run got.
- **separate-before-serializing-shared-state**: concurrent actors might write the same file, branch, key or object. Remove the sharing first; serialize only when one writer is a real invariant.
- **guard-the-context-window**: large outputs, long files, repeated reads, fan-out. Route bulk to subagents and keep summaries.

## Debug

For anyone fixing a failure.

- **fix-root-causes**: debugging. Trace each symptom back to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.
- **attack-the-premise**: two or more fixes sharing one premise failed the same gate. Write the premise down and test it before another fix assumes it.

## Review

For the reviewer (`maestro-reviewer`, `review-change`). Judge the diff against the Build group too.

- **minimize-reader-load**: code that is hard to trace. Count layers between question and answer and hidden state; collapse one-caller wrappers; shrink mutable scope.
- **test-behavior-not-implementation**: any test written, changed or kept. It must fail when the behavior breaks and pass when only the internals change.
- **laziness-protocol**: what the diff could lose and still work.
- **prove-it-works**: before calling anything done. Verify against the real artifact, not a proxy or "it compiles".

## Measure

- **explain-the-number**: before you measure, and before you trust or report a number. Find what limits it, and rule out that it measured something else. For performance, `benchmark-checklist` runs the full procedure.

## Meta

- **encode-lessons-in-structure**: you are writing the same instruction a second time, or a correction keeps coming back. Encode it as a lint, flag, check or script instead of more text. The `correct` skill applies it to a repo.
