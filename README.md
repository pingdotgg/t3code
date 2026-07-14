# SergeCode

SergeCode is a native macOS coding-agent client with an iPhone companion. The SwiftUI desktop app supervises a customized Node.js backend that manages Codex, Claude, Cursor, Grok, Fugu, and OpenCode sessions.

> [!IMPORTANT]
> SergeCode is a permanent, independent hard fork of [T3 Code](https://github.com/pingdotgg/t3code). It evolves separately and will never be merged back upstream. All issues, pull requests, and releases belong to [SergeSerb2/SergeCode](https://github.com/SergeSerb2/SergeCode).

## Prerequisites

- macOS 26 or newer
- Node.js 24
- Vite+
- at least one authenticated provider CLI

## Run from source

```bash
vp install
vp run build:server
swift run --package-path apps/mac SergeCodeMac
```

To build both the backend sidecar and a local app bundle in one step:

```bash
vp run build:local
open apps/mac/dist/SurgeCode.app
```

The iPhone companion lives in `apps/mobile`; see its README for Expo development and device-build instructions.

## Workspace

- `apps/mac` — native SwiftUI macOS app and backend sidecar supervisor
- `apps/mobile` — iPhone companion
- `apps/server` — provider, orchestration, persistence, git, HTTP, and WebSocket backend
- `packages/contracts` — shared wire contracts
- `packages/client-runtime` — shared TypeScript client runtime used by mobile
- `infra/relay` — optional remote connectivity infrastructure

See [the workspace reference](./docs/reference/workspace-layout.md) and [macOS architecture notes](./apps/mac/ARCHITECTURE.md) for more detail.

## Required checks

```bash
vp check
vp run typecheck
vp run lint:mobile
swift test --package-path apps/mac
```
