# AGENTS.md

## Task Completion Requirements

- Run `pnpm fmt:check`, `pnpm lint`, and `pnpm typecheck` before considering code tasks complete.
- Use `pnpm test` for the Vite Plus test suite.
- Current toolchain: `pnpm@11.10.0`, `node@^24.13.1`.
- When creating a worktree for a chat, create a new pull request after the work is complete.

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
- Worktree dependency copies can dereference macOS Electron framework symlinks; desktop packaging must validate an installed `Electron.app` before reusing it as `electronDist` and fall back to electron-builder's archive when invalid.
- macOS native sidebar vibrancy can leave stale/ghosted row pixels when translucent sidebar rows animate opacity/transform/color over the visual-effect backing; keep vibrancy stable across focus changes and isolate native-vibrancy thread rows with paint containment, compositor promotion, and disabled row transitions.
- External-store selectors must return a referentially stable snapshot when their input state is unchanged; fresh arrays or wrapper objects can trigger React error #185 (maximum update depth exceeded).
- Checkpoint finalization must wait for provider runtime ingestion of the matching `turn.completed` event; independent subscribers can otherwise snapshot before queued tool activities are projected.
- Full-thread diffs must filter checkpoint snapshots to the union of chat-attributed `turnFiles`; raw shared-worktree snapshots include unrelated changes from other chats.
- Retried sidebar mutations need durable mutation IDs; a lost response can hide a committed reorder, and replaying it without server deduplication can move the thread twice.
- Packaged Dev builds must write their flavor-specific `productName` into ASAR metadata; Electron derives `app.getName()` from it, and a stale Alpha name makes Dev reuse Alpha's Chromium profile.
- Filter archived sidebar hierarchies before tree normalization; archived parents must suppress both real and virtual descendants or stale children are resurrected as roots.
- Copilot ACP rejects client-supplied stdio MCP servers; expose T3 workspace handoff tools over authenticated loopback HTTP, keep permission interception enabled in full-access mode, and fail raw Git worktree mutations visibly so provider cwd, checkpoints, and diffs stay aligned.
- Never auto-cancel a Copilot permission request just because its tool kind is unrecognized; MCP/dynamic tool calls arrive as kind `other` and a silent `cancelled` outcome reads to the model as user rejection, ending the turn early with no error. Let runtime mode decide, and keep the policy's actionable set aligned with `ProjectionPipeline.isActionableApprovalRequest`.
- MCP tool implementations must not reuse the agent-facing `terminal` tool for internal spawns; its "executable name only" guard exists to constrain untrusted agent input and rejects the absolute `cliCommand` (`process.execPath`) that T3 workspace handoff tools legitimately need. Route trusted internal calls through `spawnCommand`, pass the active server `baseDir` to internal CLI calls so app flavors cannot cross-bind, and test handoff tools with an absolute CLI path rather than a PATH-resolved name.
- A workspace handoff must atomically persist the new branch/worktree and ensure a dispatchable queued continuation; reuse an existing user-queued turn instead of appending duplicate work.
- Workspace handoff retries must reuse a durable orchestration command ID. If every response is lost, preserve the created worktree because the binding may already have committed; only roll back after a definitive server rejection, and surface cleanup failures.
- Local desktop flavors must never use Official's `~/.t3` home: a local migration can replace scoped auth tables while retaining migration 31, leaving upstream `fetch-session-state` broken because the scopes migration cannot replay.
- Review findings must never be silently dropped: reviewers cite file line numbers that often land on unchanged context, so anchor findings to any line the diff renders and only discard ones naming a file outside the reviewed diff. Review threads stay conversational — refresh the result on every turn that emits reviewer JSON, re-resolve the snapshot it is anchored to, and identify the raw-JSON message by content rather than assuming it is the last assistant message.

## Keep This File Updated

- Add a **Scar** when a hard-earned lesson prevents repeat mistakes; keep each scar short, actionable, and specific.
