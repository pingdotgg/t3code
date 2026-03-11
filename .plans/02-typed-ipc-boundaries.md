# Plan: Strengthen Typed IPC Boundaries in Main Process

## Summary

Replace loose payload casting in IPC handlers with strict schema parsing and typed helper wrappers.

## Motivation

- `apps/desktop/src/main.ts` currently uses casts like `payload as Parameters<...>`.
- Casts can hide contract breakages until runtime.

## Scope

- Desktop main process IPC registration.
- Optional shared helper for handler registration.

## Proposed Changes

1. Add IPC helper utility (e.g. `apps/desktop/src/ipcHelpers.ts`) to:
   - Parse payload(s) with Zod schemas
   - Standardize typed handler signatures
2. Refactor provider IPC handlers in `apps/desktop/src/main.ts` to use:
   - `providerSessionStartInputSchema.parse`
   - `providerSendTurnInputSchema.parse`
   - `providerInterruptTurnInputSchema.parse`
   - `providerStopSessionInputSchema.parse`
3. Apply same pattern to agent/terminal handlers where possible.
4. Add tests for handler parsing failure paths (invalid payloads).

## Risks

- Refactor can subtly change IPC error shape/messages.
- Helper abstraction should stay simple and not obscure control flow.

## Validation

- `bun run test`
- `bun run typecheck`
- Manual invalid payload check from renderer/devtools to confirm fast failure.

## Done Criteria

- No provider handler uses `payload as Parameters<...>`.
- All IPC entrypoints parse unknown payloads at boundary.
