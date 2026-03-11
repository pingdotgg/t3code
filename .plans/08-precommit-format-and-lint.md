# Plan: Add Pre-Commit Formatting/Lint Hooks

## Summary

Introduce pre-commit automation so formatting and basic lint checks happen before commits.

## Motivation

- Current lint failures include formatting-only issues.
- Shift-left feedback reduces noisy CI failures and cleanup churn.

## Scope

- Root tooling config and package scripts.
- No runtime code changes.

## Proposed Changes

1. Add hook tooling (e.g. Husky + lint-staged or Lefthook).
2. Configure staged-file tasks:
   - `biome format --write`
   - `biome check`
3. Add setup docs in README.
4. Keep checks fast to avoid developer friction.

## Risks

- Slow hooks can frustrate contributors and be bypassed.
- Need to ensure compatibility with Bun workspace setup.

## Validation

- Create sample staged changes and verify hook behavior.
- Confirm formatting fixes are applied automatically.

## Done Criteria

- Pre-commit hook installed and documented.
- Formatting-only lint failures drop significantly.
