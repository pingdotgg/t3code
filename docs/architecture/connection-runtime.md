# Connection Runtime

The connection runtime is shared by web and mobile. It owns connectivity,
authentication, retries, transport lifetime, cached environment data, and
environment-scoped operations.

Web and mobile mount this runtime once at the application root. There is no
legacy connection owner or supported mixed mode.

## Ownership

Each registered environment has one scoped Effect `Context` containing focused
services:

- `EnvironmentSupervisor` owns desired state, retry scheduling, and the active
  session scope.
- `ConnectionBroker` prepares credentials and endpoints for primary, bearer,
  relay, and SSH targets.
- `RpcSessionFactory` performs one transport attempt. It does not retry.
- `EnvironmentRpc` exposes the active session without leaking the transport.
- `EnvironmentProjectCommands` and `EnvironmentThreadCommands` construct
  orchestration commands, IDs, and timestamps.
- `EnvironmentShell` and `EnvironmentThreads` own live subscriptions and cached
  snapshots.

`EnvironmentServicesFactory` assembles that context, and `EnvironmentRegistry`
owns its scope. There is no aggregate environment runtime facade. React
components do not create connections, transports, retry loops, or RPC clients.

## Connection State

The supervisor is the only retry owner.

1. A persisted or platform registration marks an environment as desired.
2. If the device is offline, the supervisor releases the active session and
   waits without consuming retry attempts.
3. When online, the supervisor asks the broker for one prepared connection and
   asks the session factory for one RPC session.
4. Transient failures retry forever with exponential backoff capped at 16
   seconds.
5. Connectivity changes, application activation, credential changes, and
   explicit user retry interrupt the current wait and trigger a fresh attempt.
6. Authentication or configuration failures remain blocked until an external
   wakeup changes the relevant input.
7. An involuntary session close keeps the registration and cache, then retries.
8. Explicit removal closes the session and deletes the registration,
   credentials, shell cache, and thread cache.

The UI derives `available`, `offline`, `connecting`, `reconnecting`,
`connected`, and `error` from supervisor state plus explicit data-sync state.
It does not infer connection health from cached data or the existence of a
transport object. An environment becomes `connected` after the socket opens and
the initial config RPC succeeds, proving that the server is responsive. Shell
and thread synchronization are independent data states. A healthy RPC
transport with a failed shell subscription is shown as connected with a
synchronization error, not as a reconnect that is not actually scheduled.

## Data Boundary

Finite requests, durable subscriptions, and commands are separate APIs:

- Query atoms revalidate when the RPC generation changes.
- Subscription atoms switch to replacement sessions.
- Expected subscription failures update domain sync state and wait for a
  replacement session; they do not take down a healthy transport.
- Mutations resolve the current environment runtime at execution time.
- Shell and thread snapshots are available while offline.
- A connected transport may have `empty`, `cached`, `synchronizing`, `live`, or
  failed shell and thread data independently.
- Cached shell and thread projections are never allowed to overwrite newer live
  data during a fast reconnect.
- Domain atom factories route effects through the environment registry and
  resolve the current scoped service at execution time.
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
connection policy.

## Source Boundaries

The public package subpaths mirror the runtime layers:

- `connection/core` contains state, catalog, retry policy, and connectivity.
- `connection/transport` contains brokerage, authorization, attempts, and RPC
  sessions.
- `connection/platform` declares capabilities and persistence contracts.
- `connection/services` contains environment-scoped data services.
- `connection/application` assembles registries, discovery, and startup.
- `connection/atoms` adapts shared services to application-owned Atom runtimes.
- `connection/presentation` contains pure UI projections.

Other reusable state lives in domain subpaths such as `shell`, `threads`,
`terminal`, and `vcs`. Applications must import explicit package subpaths; the
package intentionally has no root export.

## Application Boundary

The application root mounts the shared connection application layer, creates
its own Atom runtime, and selects the domain atom factories required by that
platform. Web and mobile may expose different hooks and features without
changing connection ownership.

Application code must not construct `WsTransport`, RPC clients, retry loops, or
raw orchestration commands. Persistence paths belong to the platform
registration and cache stores, with explicit migration or invalidation policy.

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
