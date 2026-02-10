# CodeThing (`t3`: Node + WebSocket + Browser)

CodeThing now runs as a local Node.js runtime that serves a browser UI and exposes a local WebSocket API.

Current implementation is:

1. Codex-first: connects to `codex app-server` and streams turn/item events.
2. Provider-ready: renderer speaks a provider abstraction so Claude Code can plug in later.
3. Typed end-to-end: contracts validate payloads across the WebSocket boundary.

## Quickstart

```bash
npx t3
```

On launch, `t3`:

1. starts a local WebSocket runtime (`127.0.0.1`),
2. serves the web UI in your browser,
3. auto-connects to your current working directory as the default project.

CLI flags:

- `--no-open[=bool]` — disable browser auto-open (supports `true/false`, `1/0`, `yes/no`, `on/off` in equals form).
- `-o, --open[=bool]` — force browser auto-open (supports `true/false`, `1/0`, `yes/no`, `on/off` in equals form; overrides `T3_NO_OPEN`).
- `--backend-port <port>` — set WebSocket runtime port.
- `--web-port <port>` — set web UI port.
- `--cwd <path>` — choose launch project directory (defaults to current directory).
- `<path>` — shorthand positional argument equivalent to `--cwd <path>`.
- `-- <path>` — treat following argument as path even if it starts with `-`.
- `--version` — print CLI version.
- `--help` — print CLI usage.

`--cwd` (or positional path) must be a non-empty value pointing to an existing directory; startup fails fast with a clear error otherwise.
Port values must be decimal integers in the range `1..65535`.

If default ports are busy, `t3` will automatically retry with the next available port pair unless ports are explicitly pinned via CLI flags or environment variables.

Optional environment variables:

- `T3_NO_OPEN=1` — start runtime without auto-opening a browser window (parses `true/false`, `1/0`, `yes/no`, `on/off`).
- `T3_BACKEND_PORT` — override local WebSocket runtime port (default `4317`).
- `T3_WEB_PORT` — override local web UI port (default `4318`).

Runtime command semantics:

- `terminal.run` executes in the launch directory when `cwd` is omitted.
- Relative `cwd` values for `terminal.run` and `shell.openInEditor` resolve from the launch directory.
- `terminal.run` and `shell.openInEditor` reject empty/whitespace, missing, or non-directory cwd targets with structured request errors.

## Workspace layout

- `/apps/t3`: CLI launcher + local WebSocket runtime server.
- `/apps/desktop`: Runtime internals used by `t3` (no Electron app shell).
- `/apps/renderer`: React + Vite UI for session control, conversation, and protocol event stream.
- `/packages/contracts`: shared Zod schemas + TypeScript types for WS protocol, provider events, and API contracts.

## Codex prerequisites

- Install Codex CLI so `codex` is on your PATH.
- Authenticate Codex before running CodeThing (for example via API key or ChatGPT auth supported by Codex).
- CodeThing starts the server via `codex app-server` per session.

## Runtime boundary model

- `t3` starts a localhost-only WebSocket server.
- Launch URLs include an ephemeral WebSocket token so only the opened browser session can attach.
- Connections missing the token (or using a wrong token) are rejected by the runtime.
- Connections with duplicate token query parameters are also rejected (even when duplicate values match) to avoid ambiguous auth parsing.
- Runtime auth token lookup is strict on the lowercase `token` query key; alternate key casing is rejected.
- Connections with unexpected query parameters are rejected (auth mode requires only `token`; no-auth mode allows no query params).
- WebSocket control connections are accepted only on the root runtime path (`/`) to keep the API surface narrow.
- Unauthorized websocket attempts close with code `4001` and reason `unauthorized`.
- Browser renderer talks through a typed `NativeApi` adapter over that WebSocket.
- Runtime currently enforces a single active browser client (new client replaces old one).
- When replaced by a newer connection, the previous active websocket is closed with code `4000`.
- Replacement closes use reason string `replaced-by-new-client` for deterministic client handling.
- Renderer websocket connection errors now preserve close metadata (`code`/`reason`) to improve reconnect diagnostics.
- Renderer normalizes close metadata before diagnostics (e.g. trims close reasons and ignores malformed close codes) for cleaner error messages.
- Renderer decodes websocket message payloads from strings, `ArrayBuffer`, `ArrayBufferView` (e.g. `Uint8Array`/`DataView`), and `Blob`.
- Renderer validates provider/agent event payload shapes before dispatch, ignoring malformed event payloads to keep client state stable.
- Renderer validates critical RPC success payload shapes (`app.health`, `app.bootstrap`, `providers.listSessions`, `dialogs.pickFolder`, plus terminal/todo/provider/agent control flows) and fails fast on malformed responses.
- In-flight renderer requests now surface unauthorized/replacement disconnect causes explicitly.
- Renderer also fails in-flight requests immediately on websocket `error` events (without waiting for close) for faster feedback.
- After reconnect, renderer ignores stale events from prior sockets (including provider and agent streams) to avoid cross-connection state corruption.
- Initial websocket connect failures now include detailed diagnostics from socket/open and constructor failures (including nested/string/cause-chain payload messages, with bounded-depth fallback for malformed/cyclic payloads).
- Subsequent requests automatically reconnect after close/error disconnects, including idle (no pending request) error scenarios.
- Renderer now proactively resets the websocket after request send failures, rejects any in-flight requests, and reconnects cleanly on later requests.
- Send-failure request errors now include non-Error payload details when available (for clearer diagnostics).
- Runtime validates request payloads with shared Zod contracts.
- Runtime and renderer both validate critical success payloads with shared contracts to prevent malformed envelope data from entering app state.
- Runtime successful responses always include `result` (using `null` for void methods) to keep websocket envelopes schema-safe.
- Websocket event envelopes are channel-typed (`provider:event`, `agent:output`, `agent:exit`) and validated against shared payload schemas.
- Websocket protocol envelopes are strict (unexpected top-level fields are rejected) to keep RPC/event parsing deterministic.
- Websocket request envelope guards also cap request id/method lengths (currently 256 chars each); over-limit requests are treated as malformed and ignored.
- Codex execution sandbox policy (`read-only`, `workspace-write`, `danger-full-access`) is still selected per session startup options.
- Static HTML responses are served with `Cache-Control: no-store`; built `/assets/*` files are served with long-lived immutable cache headers.
- Static file success responses include `Accept-Ranges: bytes`, `Vary: Range`, deterministic `ETag` and `Last-Modified` validators, plus hardened browser headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Resource-Policy`, `Cross-Origin-Opener-Policy`).
- Static files support single-range byte requests (`Range: bytes=...`) with standards-compliant `206` / `416` behavior.
- Static range parsing tolerates optional separator whitespace (e.g. `Range: bytes = 0 - 1023`).
- Oversized suffix ranges are normalized to full-file spans (for example `bytes=-999999` on small assets).
- Static non-range requests support `If-None-Match` and `If-Modified-Since` conditional caching via `304 Not Modified`.
- Static range requests support `If-Range` semantics (matched validator keeps `206`; mismatched validator falls back to full `200` response).
- `If-None-Match` / `If-Modified-Since` preconditions are evaluated before range handling, so satisfied validators return `304` even when a `Range` header is present.
- Static precondition headers `If-Match` and `If-Unmodified-Since` are enforced with `412 Precondition Failed` semantics.
- Failed `If-Match` checks take precedence over cache validators (e.g. matching `If-None-Match` still results in `412` if `If-Match` fails).
- Failed `If-Unmodified-Since` checks also return `412` before cache-based `304` handling.
- Wildcard validators are supported where applicable (`If-None-Match: *`, `If-Match: *`).
- Strong/weak validator semantics follow HTTP rules: weak ETags participate in `If-None-Match` weak comparison, but are rejected for strong-only checks (`If-Match`, `If-Range`).
- `412` static precondition responses include validator headers (`ETag`, `Last-Modified`) and range capability metadata (`Accept-Ranges`, `Vary: Range`).
- `416` unsatisfiable-range responses include both range metadata and validators (`Content-Range`, `Accept-Ranges`, `Vary: Range`, `ETag`, `Last-Modified`).

## Runtime modes

CodeThing has a global runtime mode switch in the sidebar:

- `Full access` (default): starts new sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
- `Approval required`: starts new sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, then prompts in-app for command/file approvals.

Mode changes apply across all threads. Existing live sessions are restarted so old and new threads use the selected mode.

## Scripts

- `bun run dev`: builds contracts, starts `t3` runtime, opens browser UI.
- `bun run build`: builds contracts, renderer static assets, and `t3` CLI bundle.
- `bun run typecheck`: strict TypeScript checks for all packages.
- `bun run test`: runs workspace tests.
- `bun run --cwd apps/t3 dev`: run the CLI directly in dev mode.

## Provider architecture

The renderer depends on `nativeApi.providers.*`:

1. `startSession`
2. `sendTurn`
3. `interruptTurn`
4. `respondToRequest`
5. `stopSession`
6. `listSessions`
7. `onEvent`

Codex is the only implemented provider right now. `claudeCode` is reserved in contracts/UI but currently returns a not-implemented runtime error.

Runtime app utilities exposed via `nativeApi.app.*`:

1. `bootstrap`
2. `health`
