# Cluster integration tests

This suite runs multi-runner clusters against shared PostgreSQL and MySQL
containers. It is excluded from the default test projects and only registered
when `EFFECT_CLUSTER_TESTS=1`.

```sh
EFFECT_CLUSTER_TESTS=1 pnpm test-cluster
```

Docker must be running. Vitest global setup starts one `postgres:alpine` and one
`mysql:lts` container for the entire project. Every cluster uses a unique table
prefix, and every runner listens on an operating-system-assigned port.

Both databases run with commits that skip the disk flush (PostgreSQL
`fsync=off`, MySQL `innodb_flush_log_at_trx_commit=0` and `sync_binlog=0`). A
slow flush can hold a lock refresh past the 500 ms `shardLockRefreshInterval`;
the runner then fences the reply and the request replays, which breaks the
exactly-once handler counts. `Smoke.test.ts` checks these settings. The suite
tests runner failures while the database stays alive, not database crash recovery
or power-loss durability.

## Harness

`harness.ts` exposes:

- `make({ backend, entities, lockMode, config })` to create a scoped cluster harness.
- `start(count, { assignedShardGroups, entities, runnerShardWeight })` to start in-process socket runners and a client over SchemaBinary, optionally overriding the entity layer for those runners.
- `stop(runner)` for graceful deregistration and shard handoff.
- `kill(runner)` for abrupt teardown without deregistration or explicit lock cleanup.
- `freeze(runner)` to suspend SQL heartbeats and lock refresh while leaving the runner's sockets and reserved SQL connection open.
- `faultLock(runner, mode)` to blackhole, stick, fail, stick while blocking release of, or clear faults on a runner's reserved lock connection.
- `cutSocket(runner, { peer, direction })` to close one inbound or outbound client/runner connection without stopping either endpoint.
- `holdShardLockCheck(runner, shardId)` to hang that runner's next lock refresh of only `shardId`, which is how a persisted reply confirms its lock. Periodic refreshes cover every owned shard, so give the runner at least two shards and keep ownership stable while the hold is armed.
- `diskSyncSettings()` to read the database settings that decide whether a commit waits for the disk.
- `insertMessage(row)` to inject a raw row into this cluster's prefixed message table.
- `waitUntil`, `waitForStableAssignments`, and `waitForEntityOwner` for deadline-based polling with cluster diagnostics on failure.
- `clientSharding` and `ownersOfShard` for direct shard ownership assertions.
- `messageCounts`, `unprocessedMessageCount`, `repliedMessageCount`, and `failedMessageCount` for storage assertions scoped to the cluster prefix.

Advisory locks are owned by the reserved database session. A frozen advisory-lock
runner therefore keeps its locks until it is stopped or killed. Row-lock mode
uses expiry-driven takeover while frozen.

## Adding a test

Add `*.test.ts` under this directory. Test files define entities and assertions;
all cluster startup, lifecycle, waiting, and storage inspection belongs in the
harness. Use the harness polling helpers instead of calling `Effect.sleep`.
