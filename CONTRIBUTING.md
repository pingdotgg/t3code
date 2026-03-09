# Contributing to T3 Code

Thanks for your interest in contributing! This project is still early, so things move fast.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3.9
- [Node.js](https://nodejs.org) >= 24.13.1
- At least one supported coding agent installed and authorized (see [README](README.md#supported-agents))

## Setup

```bash
# This fork
git clone https://github.com/aaditagrawal/t3code.git

# Or upstream
git clone https://github.com/pingdotgg/t3code.git

cd t3code
bun install
```

## Development

```bash
bun run dev          # Start everything (server + web)
bun run dev:server   # Server only
bun run dev:web      # Web UI only
bun run dev:desktop  # Desktop app
```

## Quality checks

Both of these must pass before submitting a PR:

```bash
bun lint             # Lint with oxlint
bun typecheck        # TypeScript type checking
```

## Testing

```bash
bun run test         # Run all tests (Vitest)
```

## Project structure

| Package | Role |
| --- | --- |
| `apps/server` | Node.js WebSocket server. Wraps Codex app-server, serves the React web app, and manages provider sessions. |
| `apps/web` | React/Vite UI. Session UX, conversation/event rendering, and client-side state. |
| `packages/contracts` | Shared Effect/Schema schemas and TypeScript contracts. Schema-only — no runtime logic. |
| `packages/shared` | Shared runtime utilities. Uses explicit subpath exports (e.g. `@t3tools/shared/git`). |

## Guidelines

- **Performance and reliability first.** If a tradeoff is needed, choose correctness over convenience.
- **Avoid duplication.** Extract shared logic into `packages/shared` or `packages/contracts` rather than duplicating across files.
- **Keep it simple.** Don't over-engineer or add features beyond what's needed for the task.
- **Use ES modules.** `import/export`, not `require`.

## Need help?

Join the [Discord](https://discord.gg/jn4EGJjrvv) for support.
