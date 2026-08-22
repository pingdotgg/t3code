# effect scope plugin runtime poc

this branch isolates the t3-native implementation from the three-way plugin runtime experiment.

## shape

- a deterministic capability graph plans activation and targeted restarts
- each active plugin owns one effect `Scope`
- contributions are staged per plugin and published as frozen snapshots
- failed candidates close their scopes without replacing the live composition
- cleanup attempts every dependent-first scope and aggregates finalizer failures

this is the recommended base because t3 already uses effect. it keeps cordis's ownership and dependency rules without adding a second lifecycle runtime.

## proved

- 32 tests cover dependency order, blocking, rollback, cycles, unchanged instance reuse, order-insensitive declarations, activation implementation replacement, schema-tagged errors, active callback reentrancy, synchronous callback microtasks, plain-function callback returns, prompt activation-context expiry, descendant async tasks, late activation-context calls, queued input snapshots, observer isolation, cleanup reporting, unusual ids and slots, and immutable snapshots
- manifest validation enforces semver, prevents entrypoint path escape, and keeps mobile declarative
- the demo exercises activation, replacement, teardown, and a 250-plugin chain

## run

```sh
vp test run packages/plugin-runtime-poc/src
vp run --filter @t3tools/plugin-runtime-effect-scope-poc typecheck
vp run --filter @t3tools/plugin-runtime-effect-scope-poc demo
```

this is an isolated runtime poc. it does not load packages, add a sandbox, expose plugin rpc, or wire product ui.
