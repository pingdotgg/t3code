# Server Update Architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

Remote server updates use one stable launcher selected by the platform service manager (systemd on
Linux, launchd on macOS). Foreground CLI processes do not self-update, and a running server never
edits its service definition or durable service state.

## Ownership

The service files under `<baseDir>/runtime` are:

- `service-launcher.mjs`, the stable process selected by the service manager;
- `service-state.json`, the launcher's durable selection state;
- `versions/<version>`, immutable exact-version npm installs.

The launcher is the only runtime writer of `service-state.json`. `t3 service install` and
`t3 service update` may replace the launcher and state while the unit is stopped. Server children
only communicate with the launcher over their inherited IPC channel.

The state contains one active version and, at most, one update record:

- `pending A → B` selects B as a retryable trial;
- `committed A → B` selects B for ordinary restarts;
- `rolled-back A → B` or `failed A → B` selects A;
- invalid state fails closed so the service manager cannot guess at a runtime.

Every write uses same-directory replacement plus file and directory fsync.

## Remote Update

1. The active server installs `t3@<target>` into a unique staging directory.
2. The target runs `__service-preflight` and verifies that the stable launcher supports its update
   protocol.
3. The staging directory is renamed to its immutable version path only after preflight succeeds.
4. The active child sends `request-update`. The launcher validates the child and target, writes
   pending state, generates the update ID, then replies `update-accepted`.
5. After a short response-flush grace period, the launcher stops the active child.
6. With SQLite quiescent, the launcher snapshots the database, WAL, and shared-memory files.
7. The launcher starts the target as a trial and gives it the pending update over IPC.
8. The trial runs migrations, acquires dependencies, binds HTTP, starts every long-running root
   fiber, and verifies that each root is parked at the activation gate.
9. The trial sends `prepared`. The launcher durably commits B, deletes the snapshot, then replies
   `committed`.
10. The child opens the existing activation gate, accepts commands, and publishes lifecycle ready
    with the terminal update outcome.

Post-commit startup does not call service `start`, `initialize`, `connect`, `load`, or `acquire`
operations. It only opens prepared gates and publishes prepared lifecycle state.

The launcher serializes child exits, IPC messages, and timers. A trial must report prepared within
120 seconds. If the trial exits or times out before prepared, the launcher stops it, restores the
snapshot, records rollback, and starts A. A durable restore marker makes an interrupted restore
resume before either version can boot. After commit, B is active and the service manager's normal
restart policy applies.

## Database Rollback

The launcher snapshots `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm` after the old
server stops and before the trial starts. This makes trial migrations and writes reversible without
requiring down migrations. The snapshot is retained across launcher restarts and is removed only
after commit or after both restore and the terminal rollback state are durable.

The protocol version is part of the safety boundary. A target that requires database snapshots is
blocked when the installed launcher is too old. Upgrade the launcher once with:

```sh
npx t3@<version> service update
```

The local command stops the unit, selects the new launcher and exact runtime, then restarts the
service. Later releases, including releases with migrations, can use the remote trial path.

Snapshots briefly require enough free disk for another copy of the SQLite files. Attachments and
other files under the state directory are outside this rollback boundary.

## Client Correlation

The update acknowledgement includes the launcher-generated update ID. After reconnecting, clients
wait for a lifecycle ready event carrying that same ID. `committed` completes the operation only
when the ready server is the target version. `rolled-back` and `failed` end it immediately with the
recorded reason. Older servers without an ID retain version-only reconnect behavior.

## Capability and Compatibility

The existing additive RPC and lifecycle schemas remain compatible with older clients. New servers
advertise remote self-update only when they have valid launcher context and a live IPC channel.
Desktop-managed servers direct the user to update the desktop app. Other process shapes provide a
manual command; the old detached foreground respawn path no longer exists.

## Source Map

- Launcher and state machine: `apps/server/src/serviceLauncher.ts`
- IPC and durable state types: `apps/server/src/cloud/serviceProtocol.ts`
- Child IPC adapter: `apps/server/src/cloud/serviceLauncherClient.ts`
- Staging and preflight: `apps/server/src/cloud/pinnedRuntime.ts` and `servicePreflight.ts`
- Service installation: `apps/server/src/cloud/bootService.ts`
- Activation boundary: `apps/server/src/serverRuntimeStartup.ts` and `serverActivation.ts`
- Client outcome correlation: `packages/client-runtime/src/state/server.ts`
