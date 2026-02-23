

PR 1: Service contracts + error taxonomy
Add ProviderService, CodexService, CheckpointStore as Context.Tag service defs.
Add typed Schema.TaggedError hierarchies for all 3 services (cause: Schema.optional(Schema.Defect) on each).
No behavior change yet, just interfaces and compile-time wiring points.
PR 2: CheckpointStore Effect adapter
Wrap current filesystemCheckpointStore behind CheckpointStoreLive (adapter).
Map all thrown/Promise errors to tagged errors.
Add service tests proving parity for isGitRepository, capture, restore, diff, prune.
PR 3: CodexService Effect adapter
Wrap current CodexAppServerManager behind CodexServiceLive (adapter).
Convert public API to Effect return types with typed errors.
Preserve existing EventEmitter internally for now, but expose Effect-friendly subscribe API.
PR 4: ProviderService Effect adapter
Wrap current ProviderManager behind ProviderServiceLive (adapter).
Provider methods become Effect methods with typed errors.
Route emitted provider events through an Effect PubSub surface.
PR 5: wsServer migration to Effect services
Stop instantiating provider/codex classes directly in wsServer.
Resolve ProviderService (and related services) from one runtime/layer graph.
Keep WS contract behavior identical.
PR 6: Native CheckpointStore implementation
Refactor checkpoint internals from Promise/throws to native Effect.
Replace ad-hoc locking with Effect concurrency primitive (keyed lock/semaphore/queue).
Keep adapter tests plus new failure-path tests.
PR 7: Codex transport/RPC core as native Effect
Split codex into scoped process layer + RPC request/response layer + session registry.
Replace timeout/pending maps with Deferred + Effect timeout/finalizer semantics.
Keep protocol behavior and ordering guarantees.
PR 8: Codex protocol decoding hardening
Replace ad-hoc unknown parsing with runtime schema decoding for inbound/outbound protocol shapes.
Map decode failures to typed tagged errors (with root cause).
Add regression tests for malformed/partial protocol messages.
PR 9: Native ProviderService orchestration
Rebuild provider logic in Effect using CodexService + CheckpointStore dependencies.
Move event fanout, checkpoint capture/revert orchestration, thread-log routing to Effect state/services.
Remove throw-based flow entirely from provider path.
PR 10: Cleanup + deprecation removal
Remove legacy class implementations/adapters once parity is proven.
Finalize layer composition and startup graph docs.
Add architecture notes for service boundaries and error model.