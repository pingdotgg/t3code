# pure plugin reconciler poc

this branch isolates the framework-free implementation from the three-way plugin runtime experiment.

## shape

- an iterative capability graph plans activation and targeted restarts
- plugin instances own explicit lifo finalizer stacks
- contributions are staged per plugin and published as frozen snapshots
- failed candidates are cleaned up without replacing the live composition
- cleanup attempts every dependent-first instance and aggregates failures

this is the smallest and fastest planner in the experiment. for production, its graph algorithm should drive effect scopes rather than keeping manual finalizer ownership.

## proved

- 32 tests cover dependency order, blocking, rollback, cycles, unchanged instance reuse, order-insensitive declarations, activation implementation replacement, active callback reentrancy, synchronous callback microtasks, plain-function callback returns, prompt activation-context expiry, descendant async tasks, late activation-context calls, queued input snapshots, observer isolation, cleanup reporting, unusual ids and slots, immutable snapshots, and a 20,000-plugin stack-safe chain
- manifest validation enforces semver, prevents entrypoint path escape, and keeps mobile declarative
- the demo exercises activation, replacement, teardown, and a 250-plugin chain

## run

```sh
vp test run packages/plugin-runtime-poc/src
vp run --filter @t3tools/plugin-runtime-pure-poc typecheck
vp run --filter @t3tools/plugin-runtime-pure-poc demo
```

this is an isolated runtime poc. it does not load packages, add a sandbox, expose plugin rpc, or wire product ui.
