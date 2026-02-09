# CodeThing (Electron + Vite + Bun)

CodeThing is a desktop shell for coding agents. This first implementation is:

1. Codex-first: connects to `codex app-server` and streams turn/item events.
2. Provider-ready: renderer speaks a provider abstraction so Claude Code can plug in later.
3. Typed end-to-end: contracts validate payloads at preload/main boundaries.

## Workspace layout

- `/apps/desktop`: Electron main + preload process, includes provider and Codex session managers.
- `/apps/renderer`: React + Vite UI for session control, conversation, and protocol event stream.
- `/packages/contracts`: shared Zod schemas + TypeScript types for IPC and provider events.

## Codex prerequisites

- Install Codex CLI so `codex` is on your PATH.
- Authenticate Codex before running CodeThing (for example via API key or ChatGPT auth supported by Codex).
- CodeThing starts the server via `codex app-server` per session.

## Security and boundary model

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Renderer talks only to `window.nativeApi` exposed by preload.
- Preload and main both validate inputs using shared Zod schemas.

`sandbox: true` above is Electron renderer sandboxing. It is separate from Codex execution sandbox policy (`read-only`, `workspace-write`, `danger-full-access`) used when starting provider sessions.

## Runtime modes

CodeThing has a global runtime mode switch in the sidebar:

- `Full access` (default): starts new sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- `Approval required`: starts new sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.

Mode changes apply across all threads. Existing live sessions are restarted so old and new threads use the selected mode.

## Scripts

- `bun run dev`: starts contract build/watch, renderer dev server, and Electron process.
- `bun run build`: builds contracts, renderer, and desktop bundles through Turbo.
- `bun run typecheck`: strict TypeScript checks for all packages.
- `bun run test`: runs workspace tests.

## CI quality gates

- `.github/workflows/ci.yml` runs `bun run lint`, `bun run typecheck`, and `bun run test` on pull requests and pushes to `main`.

Optional:

- `ELECTRON_RENDERER_PORT=5180 bun run dev` if `5173` is already in use.

## Provider architecture

The renderer now depends on `nativeApi.providers.*`:

1. `startSession`
2. `sendTurn`
3. `interruptTurn`
4. `respondToRequest`
5. `stopSession`
6. `listSessions`
7. `onEvent`

Codex is the only implemented provider right now. `claudeCode` is reserved in contracts/UI but returns a not-implemented error in main-process dispatch.
