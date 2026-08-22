# cordis plugin runtime poc

this branch isolates the direct cordis implementation from the three-way plugin runtime experiment.

## shape

- real cordis `Context`, `Fiber`, `inject`, `provide`, `effect`, and `isolate` behavior
- dependency-aware differential reconciliation preserves unchanged fibers
- staged isolation symbols allow old and candidate providers to overlap transactionally
- plugin-owned contributions are published as frozen snapshots
- cleanup attempts every dependent-first fiber and aggregates finalizer failures

cordis satisfies the contract, but the adapter still needs a t3-specific planner, transaction model, snapshot format, and structural type shim. cordis rc.8's extensionless declaration re-exports do not resolve under this repository's esm settings.

## proved

- 31 tests cover dependency order, blocking, rollback, cycles, unchanged fiber reuse, order-insensitive declarations, activation implementation replacement, active callback reentrancy, synchronous callback microtasks, plain-function callback returns, prompt activation-context expiry, descendant async tasks, late activation-context calls, queued input snapshots, observer isolation, cleanup reporting, unusual ids and slots, and immutable snapshots
- manifest validation enforces semver, prevents entrypoint path escape, and keeps mobile declarative
- the demo exercises activation, replacement, teardown, and a 250-plugin chain

## run

```sh
vp test run packages/plugin-runtime-poc/src
vp run --filter @t3tools/plugin-runtime-cordis-poc typecheck
vp run --filter @t3tools/plugin-runtime-cordis-poc demo
```

this is an isolated runtime poc. it does not load packages, add a sandbox, expose plugin rpc, or wire product ui.
