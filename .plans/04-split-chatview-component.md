# Plan: Split ChatView into Smaller UI/Logic Units

## Summary

Refactor `ChatView.tsx` into composable pieces with isolated responsibilities.

## Motivation

- `apps/renderer/src/components/ChatView.tsx` is large and handles:
  - Session orchestration
  - Send/interrupt actions
  - Timeline rendering
  - Header/status UI
  - Composer UI
- Hard to test and maintain as one component.

## Scope

- Renderer component boundaries and hooks.
- Keep visual behavior unchanged.

## Proposed Changes

1. Create hook: `apps/renderer/src/hooks/useChatSession.ts`
   - `ensureSession`
   - `sendTurn`
   - `interruptTurn`
2. Split presentational components:
   - `components/chat/ThreadHeader.tsx`
   - `components/chat/MessageTimeline.tsx`
   - `components/chat/ComposerBar.tsx`
3. Keep `ChatView.tsx` as container wiring store + hook + child components.
4. Add focused tests for hook behavior (error handling, session reuse).

## Risks

- Refactor can break subtle UI interactions (auto-scroll, menu close, keyboard send).

## Validation

- `bun run test`
- Manual smoke: send, stream, interrupt, model switch.

## Done Criteria

- `ChatView.tsx` significantly reduced and easier to scan.
- Session logic isolated from rendering.
