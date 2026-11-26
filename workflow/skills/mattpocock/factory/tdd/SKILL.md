---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle: consult them before and during the loop, not after.

When exploring the codebase, read `GLOSSARY.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. The `principle-test-behavior-not-implementation` skill is the rule; this section shows it. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists, and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam. You can't test everything, so agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?" Give each proposed seam a one-line note on what it catches and what it misses. When nobody can confirm them, as in an unattended run, record the seams and those notes where the reviewer will read them (under `maestro`: a `maestro: decided` comment on the issue), and treat that record as the agreement.

## Should this test exist?

Ask before writing each red test. Write it only when every answer holds:

- **It catches a regression someone would hit.** Name it in one line. "Covers the function" is not a regression.
- **No existing test already covers it.** If one is close, add a row or an assertion to it instead of a new case.
- **It sits at one layer, the lowest that would fail without the change.** Do not repeat it in a wrapper, at each call site, or in a copy of the same logic.
- **It is not something a test should leave out:** what the types already guarantee, trivial logic, copy text, a smoke run, a mirror of mock calls, callback wiring, or markup rendered with no behavior behind it.

The repo's own testing guide wins where it says more. A bug fix gets the fewest tests that fail for the bug's reason, then the fix.

When the shape of that interface is itself in question (how deep the module is, where the seam belongs, what the interface should expose), use the "codebase-design" skill for the vocabulary. It is the shared source of the module, interface, depth, seam, adapter, leverage and locality terms, and it is a reference to consult, not a session to run.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

Order the loop's steps and commits per `~/.agents/skills/principle-sequence-verifiable-units/SKILL.md`.

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle. A slice that an existing case can absorb gets a new row there, not a new test.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the `review-change` skill), not the red → green implementation cycle.
