# Workbench

Workbench is a folder-first AI workbench for real tasks and real files.

It's built for knowledge workers, technical-adjacent builders, and developers who want a calmer interface for agent-driven work. The goal is to feel like **"AI that can actually work in my folder"**, not just a chat window or a developer IDE.

## Quick start

Requires [Bun](https://bun.sh/) and Node 20+.

```bash
bun install
bun run dev
```

This starts the desktop app in development mode, the local backend server, and the web app in parallel via Turbo.

For other commands:

```bash
bun fmt        # format
bun lint       # lint
bun typecheck  # type-check
bun run test   # vitest
```

## Repo layout

| Path | What it is |
|---|---|
| `apps/desktop/` | Electron shell — packages the web app + local backend into a desktop binary |
| `apps/web/` | React + Vite frontend (the actual UI) |
| `apps/server/` | Bun + Effect WS server — runs as the local backend or as a headless server |
| `apps/marketing/` | Astro marketing site |
| `packages/contracts/` | Shared schema + RPC contracts between web and server |
| `packages/` | Other shared libraries |
| `scripts/` | Build, release, and tooling scripts |
| `assets/` | App icons + branding assets |

## Connecting from another device

See [REMOTE.md](./REMOTE.md) for pairing the desktop app with a Workbench server running on another machine.

## Acknowledgements

Workbench is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), substantially rebranded and reshaped for non-developer workflows. Many of the underlying primitives (provider adapters, orchestration, the diff viewer) come straight from that work.
