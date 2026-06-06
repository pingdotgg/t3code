# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

Salchi is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Effect Safety Rules

Effect lifecycle code is high risk in this repo. Treat changes to `ManagedRuntime`, `Scope`, stream subscriptions, RPC protocol layers, and WebSocket transport as infrastructure work, not ordinary app logic.

Before changing Effect lifecycle code:

- Inspect the installed Effect version in `node_modules/.bun/effect@.../node_modules/effect/dist/*.d.ts` or source. Do not rely on memory for `ManagedRuntime`, `Scope`, `Stream`, `Fiber`, or interruption semantics.
- Identify the owner of every resource/fiber/scope being touched.
- Confirm how cancellation happens: returned interruptor, scope close, runtime dispose, stream completion, or explicit unsubscribe.
- Write or update a focused test that fails before the lifecycle change.
- Prefer using existing local wrappers (`WsTransport`, `createEnvironmentConnection`, orchestration recovery helpers) over introducing new Effect patterns.

Avoid unless explicitly required:

- Changing `WsTransport` session lifecycle.
- Changing `createWsRpcProtocolLayer`.
- Closing scopes from new code paths.
- Adding new detached fibers.
- Changing stream retry/resubscribe behavior.
- Converting non-blocking reconnect work into blocking work.

For WebSocket/resume bugs, prefer this order:

1. Reconcile or refresh using existing RPCs.
2. Add diagnostics to prove state transitions.
3. Coalesce duplicate recovery work.
4. Only then consider transport/runtime lifecycle changes.

Required verification for Effect lifecycle changes:

- A focused regression test for the exact failure mode.
- A cancellation/interruption test if scopes, fibers, streams, or `runCallback` are changed.
- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test` for the relevant package/test file.

Never run `bun test`.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

Salchi is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
