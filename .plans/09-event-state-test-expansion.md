# Plan: Expand Event/State Transition Test Coverage

## Summary

Add focused tests for renderer event handling and session evolution logic.

## Motivation

- Core behavior is event-driven and stateful.
- Existing renderer tests cover only a subset of timeline/model behavior.

## Scope

- `apps/renderer/src/session-logic.test.ts`
- Optional reducer tests for `apps/renderer/src/store.ts`.

## Proposed Changes

1. Add tests for `evolveSession`:
   - `thread/started`
   - `turn/started`
   - `turn/completed` success/failure
   - error/session closed events
2. Add tests for `applyEventToMessages`:
   - start/delta/completed flow
   - out-of-order event cases
   - turn completion clearing streaming flags
3. Add reducer integration tests for `APPLY_EVENT`.

## Risks

- Tests may be brittle if event payload fixtures are too coupled to implementation details.

## Validation

- `bun run test`
- Ensure new tests remain deterministic and fast.

## Done Criteria

- High-risk event transitions are covered by unit tests.
- Regressions in stream assembly/session status are caught quickly.
