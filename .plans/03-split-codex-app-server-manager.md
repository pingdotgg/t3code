# Plan: Decompose CodexAppServerManager

## Summary

Split `CodexAppServerManager` into smaller modules with clear responsibilities.

## Motivation

- `apps/desktop/src/codexAppServerManager.ts` is large and mixes:
  - Process lifecycle
  - JSON-RPC parsing/routing
  - Session state transitions
  - Event emission
- This increases regression risk and slows changes.

## Scope

- Desktop provider internals only.
- Keep external behavior/API stable.

## Proposed Changes

1. Extract modules:
   - `codex/processLifecycle.ts`
   - `codex/jsonrpcRouter.ts`
   - `codex/sessionState.ts`
   - `codex/parsing.ts`
2. Keep `CodexAppServerManager` as thin orchestrator/facade.
3. Move pure helpers (`classifyCodexStderrLine`, route parsing) into unit-testable files.
4. Add targeted unit tests for:
   - Message classification
   - Request/notification/response routing
   - Session state transitions

## Risks

- Reordering event handling can change behavior.
- Must preserve pending request timeout/cancellation semantics.

## Validation

- Existing tests pass.
- Add module-level tests for parsing and transition logic.

## Done Criteria

- Main manager file materially smaller and orchestration-focused.
- Core protocol/state logic covered by focused tests.
