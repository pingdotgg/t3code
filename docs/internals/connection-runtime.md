# Connection Runtime

> For maintainers. Using T3 Code? See [docs/user](../user/).

The connection runtime is shared by web and mobile. It owns connectivity,
authentication, retries, transport lifetime, cached environment data, and
environment-scoped operations.

Web and mobile mount this runtime once at the application root and compose it
identically: `apps/web/src/connection/runtime.ts` and
`apps/mobile/src/connection/runtime.ts` differ only in the platform layer they
supply. There is no legacy connection owner or supported mixed mode.

## Composition

[`connection/layer.ts`][layer] assembles the runtime:

- `ConnectionResolver` ([resolver.ts][resolver]) resolves a catalog entry into a
  prepared, authenticated endpoint for primary, bearer, relay, or SSH targets.
- `ConnectionDriver` ([driver.ts][driver]) prepares through the resolver, opens
  one RPC session, and reports `preparing`, `opening`, and `synchronizing`.
- `RpcSessionFactory` ([rpc/session.ts][session]) performs one transport
  attempt. It does not retry. `RpcSession` is the interface it returns,
  exposing `client`, `initialConfig`, `ready`, `probe`, and `closed`.
- `EnvironmentRegistry` ([registry.ts][registry]) owns the catalog and the
  per-environment scopes.
- `ConnectionOnboarding` and `RelayEnvironmentDiscovery` sit alongside the
  registry. Startup calls `EnvironmentRegistry.start` and streams platform
  registrations into `reconcilePlatform`.

The registry creates one environment-scoped supervisor per environment.
`acquireSupervisor` serializes access per environment, reuses an existing
supervisor when the catalog entry is unchanged, and closes and recreates the
scope when it changed. `createServiceScope` builds an `EnvironmentSupervisor`
bound to a closeable scope and connects it; `run` and `runStream` execute caller
effects with that supervisor provided.

`EnvironmentSupervisor` owns desired state, retry scheduling, and the active
session scope. React components do not create connections, transports, retry
loops, or RPC clients.

## Connection State

The supervisor is the only retry owner.

1. A persisted or platform registration marks an environment as desired.
2. If the device is offline, the supervisor releases the active session and
   waits for a signal without consuming retry attempts or running a timer.
3. When online, it asks the driver for one prepared connection and one RPC
   session.
4. Transient failures retry forever with exponential backoff capped at 16
   seconds (`RETRY_DELAYS_MS`). A connection stable for 30 seconds resets
   accumulated backoff.
5. Authentication or configuration failures remain blocked until an external
   wakeup changes the relevant input.
6. An involuntary session close keeps the registration and cache, then retries.
7. Explicit removal closes the session and deletes the registration,
   credentials, shell cache, and thread cache.

### Wakeups

Wakeup handling differs by phase, in [supervisor.ts][supervisor]:

- During establishment, `waitForEstablishmentInterrupt` consumes and **ignores**
  plain application activation. Restarting an in-flight attempt because the app
  came to the foreground would only delay it. The exception is
  `application-active-reconnect`, which mobile emits after a meaningful
  background suspension; it interrupts establishment and resets the retry
  ladder, because the OS may have silently killed the socket underneath the
  attempt.
- Credential changes interrupt establishment only for relay targets, where a new
  credential changes what is being established.
- Explicit disconnect, explicit retry, and going offline interrupt establishment
  in every case.
- While waiting out backoff, application activation resets the retry ladder so a
  foregrounded app reconnects immediately instead of serving the remaining
  delay.
- Once connected, `monitorConnectedLease` handles plain activation by probing
  the existing session (`lease.session.probe`, with a shorter timeout for
  mobile's `application-active-probe`) rather than reconnecting; a healthy
  session survives foregrounding. `application-active-reconnect` skips the probe
  and replaces the lease outright.

The UI derives `available`, `offline`, `connecting`, `reconnecting`,
`connected`, and `error` from supervisor state plus explicit data-sync state.
It does not infer connection health from cached data or the existence of a
transport object. An environment becomes `connected` after the socket opens and
the initial config RPC succeeds, proving that the server is responsive. Shell
and thread synchronization are independent data states. A healthy RPC transport
with a failed shell subscription is shown as connected with a synchronization
error, not as a reconnect that is not actually scheduled.

## Data Boundary

Finite requests, durable subscriptions, and commands are separate APIs:

- Query atoms revalidate when the RPC generation changes.
- Subscription atoms switch to replacement sessions.
- Subscription failure handling in [rpc/client.ts][client] distinguishes two
  cases. A transport failure (`isTransportFailure`: every failure is an RPC
  client error) ends the inner subscription without resubscribing, so the outer
  stream waits for the supervisor to supply a replacement session. A handled
  domain failure runs `onExpectedFailure` and, when
  `retryExpectedFailureAfter` is set, sleeps and resubscribes on the **same**
  session. A healthy transport is never torn down for a domain failure.
- Mutations resolve the current environment runtime at execution time.
- Shell and thread snapshots are available while offline.
- Sync status is explicit and independent per domain. Shell status is `empty`,
  `cached`, `synchronizing`, or `live`, with a separate `error` field; there is
  no `failed` status. Thread status adds `deleted`.
- Cached shell and thread projections are never allowed to overwrite newer live
  data during a fast reconnect.
- Domain atom factories route effects through the environment registry and
  resolve the current scoped service at execution time. Project and thread
  commands are Atom factories under `src/state`
  (`createProjectEnvironmentAtoms`, `createThreadEnvironmentAtoms`), as are the
  shell and thread state factories (`createEnvironmentShellAtoms`,
  `createEnvironmentThreadStateAtoms`).
- Web and mobile own their Atom runtimes, React hooks, and feature composition.

The Promise bridge exists only at the React/Atom boundary. Runtime and business
logic remain Effect-native.

## Platform Layers

Web and mobile provide:

- network status and network-change streams;
- application lifecycle wakeups;
- cloud session credentials;
- device identity;
- platform registrations;
- persistent catalog, credential, shell, and thread stores;
- HTTP, crypto, and telemetry layers.

Platform layers adapt operating-system capabilities. They do not implement
connection policy. `EnvironmentOwnedDataCleanup` is part of this contract: on
removal the registry clears its cache and calls the platform implementation, so
web clears composer drafts and mobile clears drafts plus the thread outbox.

## Source Boundaries

Applications must import explicit package subpaths; the package intentionally
has no root export. The subpaths are documented in
[packages/client-runtime/README.md](../../packages/client-runtime/README.md),
with the `exports` map in that package's `package.json` as the authoritative
list. Files that are not exported are implementation details.

## Application Boundary

The application root mounts the shared connection layer, creates its own Atom
runtime, and selects the domain atom factories required by that platform. Web
and mobile may expose different hooks and features without changing connection
ownership.

Application code must not construct RPC clients, retry loops, or raw
orchestration commands. Persistence paths belong to the platform registration
and cache stores, with explicit migration or invalidation policy.

## Verification

Core state-machine tests use `@effect/vitest` and deterministic service layers.
Required coverage includes:

- offline startup and online wakeup;
- forever retry with the 16-second cap;
- explicit retry interrupting backoff;
- authentication wakeups;
- involuntary close and reconnect;
- explicit removal clearing all owned state;
- relay token reuse and refresh;
- progressive relay discovery;
- shell and thread cache hydration;
- durable subscriptions switching sessions;
- command metadata and idempotent queued-command metadata.

[layer]: ../../packages/client-runtime/src/connection/layer.ts
[resolver]: ../../packages/client-runtime/src/connection/resolver.ts
[driver]: ../../packages/client-runtime/src/connection/driver.ts
[registry]: ../../packages/client-runtime/src/connection/registry.ts
[supervisor]: ../../packages/client-runtime/src/connection/supervisor.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[client]: ../../packages/client-runtime/src/rpc/client.ts
