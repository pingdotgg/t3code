# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Current toolchain: `pnpm@11.10.0`, `node@^24.13.1`.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures: session restarts, reconnects, and partial streams.

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long-term maintainability is a core priority. Before adding functionality, check whether shared logic should be extracted. Avoid duplicated logic, don't be afraid to change existing code, and don't solve problems with narrow local shortcuts.
Write only the small, concise amount of code needed to solve the problem; avoid unnecessary abstraction, features, and complexity.

## Scars

- `packages/contracts` stays schema-only; no runtime logic.
- `packages/shared` uses explicit subpath exports; do not add a barrel index.
- Provider runtime activity is projected into orchestration domain events server-side before the web app consumes it.
- Session startup/resume and turn lifecycle are fragile paths; optimize for predictable restart/reconnect behavior over quick local fixes.
- Bounded provider event channels must preserve teardown event order during normal stops; suppress new events only after adapter-layer shutdown begins instead of detaching terminal offers.
- A pre-acknowledgement `provider.turn.start.failed` activity terminally settles its user message; preserve the activity's `messageId` so reconnects cannot leave the thread permanently in flight.
- SQLite migration IDs are globally append-only; choose an ID above every historical ledger entry, including migrations from divergent branches no longer present in the current source tree.
- `provider_session_runtime.status = running` means the provider runtime is alive, not that a turn is active; clear `runtime_payload_json.activeTurnId` after `ProviderService.sendTurn` settles and keep a Copilot provider smoke test that starts a session, selects a model, sends a turn, observes output, and stops the session.
- Before a Copilot session exits, emit `task.completed` with `status = stopped` for every running background agent, and reconcile unmatched starts on server startup so crashes cannot leave sidebar runs permanently active.
- Packaged desktop startup builds cloud runtime services eagerly; `CloudRuntimeLayerLive` must provide its own auth control plane, server environment, orchestration, repository identity, and persistence dependencies, and startup logs should include a clear cloud-runtime-ready marker.
- macOS native sidebar vibrancy can leave stale/ghosted row pixels when translucent sidebar rows animate opacity/transform/color over the visual-effect backing; keep vibrancy stable across focus changes and isolate native-vibrancy thread rows with paint containment, compositor promotion, and disabled row transitions.
- External-store selectors must return a referentially stable snapshot when their input state is unchanged; fresh arrays or wrapper objects can trigger React error #185 (maximum update depth exceeded).

## Keep This File Updated

- Add a **Scar** when a hard-earned lesson prevents repeat mistakes; keep each scar short, actionable, and specific.
