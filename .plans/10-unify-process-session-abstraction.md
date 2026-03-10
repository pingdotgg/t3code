# Plan: Unify Process and PTY Session Abstractions in ProcessManager

## Summary

Refactor `ProcessManager` to use a single runtime-session interface for child-process and PTY modes.

## Motivation

- `apps/desktop/src/processManager.ts` maintains parallel maps and branch-heavy logic.
- New execution backends/providers will multiply complexity.

## Scope

- Desktop process execution internals.
- Preserve public `ProcessManager` API.

## Proposed Changes

1. Introduce internal interface (e.g. `RuntimeSession`):
   - `write(data)`
   - `kill()`
   - lifecycle/output event hooks
2. Implement:
   - `ChildProcessSession`
   - `PtySession`
3. Replace dual maps with one `Map<string, RuntimeSession>`.
4. Keep output/exit event contract unchanged.
5. Add tests for both implementations.

## Risks

- PTY behavior differs by platform; abstraction must not hide required differences.

## Validation

- Existing `processManager.test.ts` passes.
- Add PTY-path tests where feasible.

## Done Criteria

- Manager no longer branches per backend in `write/kill/killAll`.
- Session backends are independently testable.
