# Effect Migration Plan (From Current State)

Current status summary:

- Service contracts, typed errors, and most checkpoint/persistence services exist.
- `ProviderServiceLive` is already native orchestration (not a thin adapter).
- Production server path still uses legacy `ProviderManager`/`FilesystemCheckpointStore`.
- Checkpoint flow now avoids snapshot re-sync and is write-time driven.

## PR 1: Wire Provider/Checkpoint Effect Stack Into `wsServer`

- Build one runtime layer graph for provider + checkpoint + persistence + orchestration.
- Resolve `ProviderService` from runtime in `wsServer`.
- Replace `ProviderManager` method calls in WS handlers with `ProviderService` calls.
- Forward provider events by subscribing to `ProviderService.subscribeToEvents`.
- Keep WS method/push payloads identical.

## PR 2: Runtime Composition + Startup Ownership

- Create/centralize `AppLive` composition for server startup.
- Ensure outer runtime provides Node/platform services once.
- Ensure migrations run at startup via scoped/layer startup path.
- Remove ad-hoc service initialization in request-time paths.

## PR 3: Session Lifecycle Hygiene + Checkpoint Invariants

- Add explicit checkpoint session cleanup on `stopSession` / `stopAll`.
- Remove per-session lock/cwd map leaks.
- Keep strict invariant model:
  - root checkpoint created at session initialization before agent modifications
  - each completed turn captures filesystem checkpoint and persists metadata
  - no after-the-fact metadata rebuild/sync
- Add tests for lifecycle cleanup and invariant-failure surfaces.

## PR 4: Provider Event Stream Hardening (Without Extra Service Fragmentation)

- Keep `ProviderService` as the public event surface.
- Internally move callback fanout to Effect concurrency primitives (`Queue`/`PubSub`) for ordering/backpressure control.
- Keep API as `subscribeToEvents` unless we explicitly choose stream API later.
- Add tests for ordering and subscriber isolation under load.

## PR 5: Codex Runtime Split (Scoped Effect Core)

- Extract `CodexAppServerManager` responsibilities into Effect-native layers:
  - scoped process lifecycle
  - RPC request/response + pending map via `Deferred`
  - session registry/state
- Keep `CodexAdapter` contract stable while swapping internals.
- Preserve protocol behavior and timeout semantics.

## PR 6: Codex Protocol Decode Hardening

- Replace ad-hoc unknown parsing with runtime schema decode.
- Map decode failures to typed tagged errors with `cause` retained.
- Add regression tests for malformed/partial protocol frames.

## PR 7: Remove Legacy Provider Stack

- Remove `ProviderManager` + legacy checkpoint integration from runtime path.
- Remove `FilesystemCheckpointStore` from active server flow (keep only if explicitly needed for compatibility tooling).
- Update tests to assert only Effect service path is used.

## PR 8: Final Cleanup + Docs

- Update architecture docs with final layer graph and service boundaries.
- Document error model and recovery semantics.
- Trim dead compatibility code and stale plan references.
