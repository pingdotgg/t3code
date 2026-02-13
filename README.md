# T3 Code

T3 Code is a minimal web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.

Run `npx t3` in any project directory to launch the web interface.
Run `bun run dev:desktop` to launch the Electron desktop app in this monorepo.

## Architecture

T3 Code runs as a **Node.js WebSocket server** that wraps `codex app-server` (JSON-RPC over stdio) and serves a React web app.

```
┌─────────────────────────────────┐
│  Browser (React + Vite)         │
│  Connected via WebSocket        │
└──────────┬──────────────────────┘
           │ ws://localhost:3773
┌──────────▼──────────────────────┐
│  apps/server (Node.js)          │
│  WebSocket + HTTP static server │
│  ProviderManager                │
│  CodexAppServerManager          │
└──────────┬──────────────────────┘
           │ JSON-RPC over stdio
┌──────────▼──────────────────────┐
│  codex app-server               │
└─────────────────────────────────┘
```

## Workspace layout

- `/apps/server`: Node.js WebSocket server. Wraps Codex app-server, serves the built web app, and opens the browser on start.
- `/apps/web`: React + Vite UI. Session control, conversation, and provider event rendering. Connects to the server via WebSocket.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `t3` backend process and loads the shared web app.
- `/packages/contracts`: Shared Zod schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.

## Codex prerequisites

- Install Codex CLI so `codex` is on your PATH.
- Authenticate Codex before running T3 Code (for example via API key or ChatGPT auth supported by Codex).
- T3 Code starts the server via `codex app-server` per session.

## Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set
T3CODE_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Or from any project directory after publishing:
npx t3
```

## Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.

### Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `3773`, web `5173`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a bun run dev:desktop`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.

## Runtime modes

T3 Code has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.

## Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: `{ type: "push", channel, data }` for streaming provider events

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`, `providers.listSessions`
- `shell.openInEditor`, `server.getConfig`

Codex is the only implemented provider. `claudeCode` is reserved in contracts/UI.

## CI quality gates

- `.github/workflows/ci.yml` runs `bun run lint`, `bun run typecheck`, and `bun run test` on pull requests and pushes to `main`.
