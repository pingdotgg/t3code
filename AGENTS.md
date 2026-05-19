# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server and Claude Agent SDK (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `apps/desktop`: Electron shell. Spawns a desktop-scoped `t3` backend process and loads the shared web app.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Provider Architecture

T3 Code supports multiple coding agents through a unified provider interface:

### Codex (`provider: "codex"`)

The primary provider. The server starts `codex app-server` (JSON-RPC over stdio) per session, then streams structured events to the browser through WebSocket push messages.

- **Low-level manager**: `apps/server/src/codexAppServerManager.ts` handles direct communication with `codex app-server`.
- **High-level adapter**: `apps/server/src/provider/Layers/CodexAdapter.ts` wraps the manager behind the `CodexAdapter` service contract.
- **Session lifecycle**: Managed by `ProviderService` in `apps/server/src/provider/Services/ProviderService.ts`.

### Claude (`provider: "claudeAgent"`)

Fully implemented provider using the Claude Agent SDK.

- **Adapter**: `apps/server/src/provider/Layers/ClaudeAdapter.ts` wraps `@anthropic-ai/claude-agent-sdk` query sessions.
- **Session lifecycle**: Also managed by `ProviderService`.

### How Providers Work

1. WebSocket requests route to `ProviderService` in `wsServer.ts`.
2. `ProviderService` delegates to the appropriate adapter (`CodexAdapter` or `ClaudeAdapter`).
3. Adapters talk to their respective agent runtimes and emit canonical runtime events.
4. Events flow through queue-backed workers (`ProviderRuntimeIngestion`, `ProviderCommandReactor`, `CheckpointReactor`).
5. Domain events are persisted and projected into the read model.
6. Updates are pushed to the browser via `ServerPushBus`.

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
