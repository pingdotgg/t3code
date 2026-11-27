# @effect/platform-cloudflare

Runs Effect Cluster on [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/). Every entity instance is one Durable Object, the Worker is the edge, and each object's SQLite storage is the system of record.

This package is experimental. Its APIs may change in patch releases.

## Installation

```sh
npm install effect@rc @effect/platform-cloudflare@rc
```

## Usage

The package ships four Durable Object classes. Re-export them from your Worker entry module and bind each one as a SQLite-backed class:

```jsonc
// wrangler.jsonc
{
  "name": "my-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2026-08-01",
  "durable_objects": {
    "bindings": [
      { "name": "CLUSTER_ENTITY", "class_name": "ClusterEntity" },
      { "name": "CLUSTER_WORKFLOW", "class_name": "ClusterWorkflow" },
      { "name": "CLUSTER_QUEUE", "class_name": "ClusterDurableQueue" },
      { "name": "CLUSTER_SINGLETON", "class_name": "ClusterSingleton" },
    ],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "ClusterEntity",
        "ClusterWorkflow",
        "ClusterDurableQueue",
        "ClusterSingleton",
      ],
    },
  ],
  "triggers": {
    "crons": ["0 * * * *"],
  },
}
```

```ts
// src/worker.ts
import { CloudflareCluster, CloudflareDurableObjects } from "@effect/platform-cloudflare"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Entity, Singleton } from "effect/cluster"
import { Rpc } from "effect/rpc"

export {
  ClusterDurableQueue,
  ClusterEntity,
  ClusterSingleton,
  ClusterWorkflow
} from "@effect/platform-cloudflare/CloudflareDurableObjects"

// The same Entity + RpcGroup definitions as on every other cluster path
const Counter = Entity.make("Counter", [
  Rpc.make("Increment", { success: Schema.Number })
])

const CounterLayer = Counter.toLayer({
  Increment: () => Effect.succeed(1)
})

const MaintenanceLayer = Singleton.make(
  "hourly-maintenance",
  Effect.logInfo("Running hourly maintenance")
)

const clusterLayer = (env: Env) =>
  Layer.merge(CounterLayer, MaintenanceLayer).pipe(
    Layer.provideMerge(CloudflareCluster.layer({
      entities: [Counter],
      entityNamespace: env.CLUSTER_ENTITY,
      workflowNamespace: env.CLUSTER_WORKFLOW,
      queueNamespace: env.CLUSTER_QUEUE,
      singletonNamespace: env.CLUSTER_SINGLETON
    }))
  )

// Build registration lazily inside the first Worker or Durable Object event.
// Each call builds a fresh ManagedRuntime, so a retry after a failed or
// stalled build starts over. The first runtime to finish is kept for the
// lifetime of this Worker isolate.
let application: ManagedRuntime.ManagedRuntime<any, any> | undefined
const initialize = CloudflareDurableObjects.setInitializer(async (env: Env) => {
  if (application !== undefined) return application.context()
  const runtime = ManagedRuntime.make(clusterLayer(env))
  const context = await runtime.context().catch(async (error) => {
    await runtime.dispose()
    throw error
  })
  if (application === undefined) {
    application = runtime
    return context
  }
  // A stalled build finished after a replacement: keep the replacement.
  await runtime.dispose()
  return application.context()
})
```

The initializer is the readiness contract shared by all four Durable Object
classes. Each cold object waits for it through `blockConcurrencyWhile` before
handling a request or alarm, and concurrent cold objects still build the
application only once per Worker isolate. If initialization fails, the failure
is returned to every caller waiting on that build, and the next cold object
runs the initializer again. Because the initializer runs inside a Durable
Object constructor's `blockConcurrencyWhile`, which Cloudflare cancels after 30
seconds, it must complete within 15 seconds. A build still pending after 15
seconds is treated as abandoned. Only an object that has waited less than 15
seconds runs the initializer itself, whether it replaces a stalled build or
retries after a failure, so any replacement also gets at least 15
seconds. A slow build can therefore run more than once in an isolate, and the
initializer must tolerate that. The example above keeps the first runtime to
finish and disposes any other.
Worker request handlers should call the same `initialize(env)` function before
using `application`.

Applications whose registrations are complete synchronously during module
evaluation can keep the previous bare re-export pattern without an initializer.
Asynchronous layer builds must register one before serving traffic.

The Cron Trigger wakes the named singleton through its same-Worker binding.
The call returns after one run, allowing the Durable Object to hibernate; do
not make the singleton effect a forever loop. A failed run is logged by the
singleton object and resolves `wake()` with `{ _tag: "Failure", message }`, so
a rejected `wake()` means the call failed in transit and can be retried.

```ts
export default {
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const singleton = env.CLUSTER_SINGLETON.getByName("Singleton/hourly-maintenance")
    ctx.waitUntil(singleton.wake())
  }
}
```

`Entity.client` stays the user API. The Worker encodes `(type, id)` into the Durable Object name and resolves the object with `getByName`; an unknown entity type fails at the Worker before any Durable Object is contacted.

### Waking a `ClusterCron`

`ClusterCron.make` registers a seed singleton named `ClusterCron/<name>` that
schedules the first run. On the other cluster backends that singleton starts as
soon as a runner holds its shard. Here a singleton runs only when something
wakes it, and nothing seeds it for you, so a `ClusterCron` never fires until a
Cron Trigger wakes its seed singleton.

`CloudflareCluster.clusterCronSingletonName(name)` returns that singleton name.
After the first wake each run schedules the next one through a destination
alarm. Waking it on every trigger is safe: a run already scheduled for the same
instant is deduplicated, and the wake restarts a schedule that was lost.

```ts
const NightlyReport = ClusterCron.make({
  name: "nightly-report",
  cron: Cron.parseUnsafe("0 2 * * *", "UTC"),
  execute: Effect.logInfo("Sending the nightly report")
})

export default {
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const name = CloudflareCluster.clusterCronSingletonName("nightly-report")
    ctx.waitUntil(env.CLUSTER_SINGLETON.getByName(`Singleton/${name}`).wake())
  }
}
```

Merge `NightlyReport` into the layer passed to `CloudflareCluster.layer`, like
any other singleton.

## Deploying with Alchemy

[Alchemy](https://alchemy.run) v2 ("Infrastructure as Effects") is the second
deployment story, behind the optional `@alchemy.run/cloudflare` peer dependency
(`>=2.0.0-beta.85 <3`). The Wrangler path above never imports it.

```sh
npm install alchemy@beta @alchemy.run/cloudflare@beta
```

With Alchemy there is no wrangler config, no class re-exports, and no
initializer: `AlchemyCloudflareCluster.make` runs inside the Effect-native
`Cloudflare.Worker` init program and registers the four Durable Object
classes itself, so Alchemy owns the bindings, class exports, and SQLite
migrations across deploys. Cron Triggers stay user-declared through
`cluster.wake`:

```ts
// src/worker.ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as AlchemyCloudflareCluster from "@effect/platform-cloudflare/AlchemyCloudflareCluster"
import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export default Cloudflare.Worker(
  "MyApp",
  {
    main: import.meta.url
  },
  Effect.gen(function*() {
    const cluster = yield* AlchemyCloudflareCluster.make({
      entities: [Counter],
      layer: Layer.mergeAll(CounterLayer, MaintenanceLayer, NightlyReport)
    })

    yield* Cloudflare.Workers.cron("0 * * * *", cluster.wake("hourly-maintenance"))
    // A ClusterCron fires only after a Cron Trigger wakes its seed singleton
    yield* Cloudflare.Workers.cron(
      "30 * * * *",
      cluster.wake(CloudflareCluster.clusterCronSingletonName("nightly-report"))
    )

    return {
      // routes using Entity.client, etc.
      fetch: cluster.provide(handler)
    }
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive))
)
```

```ts
// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Alchemy from "alchemy"
import * as Effect from "effect/Effect"
import App from "./src/worker.ts"

export default Alchemy.Stack(
  "MyApp",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const app = yield* App
    return { url: app.url }
  })
)
```

`make` builds the cluster layer merged with your handler layer into the
isolate-lifetime scope and hands back `provide` for the Worker's handlers, so
do not wrap the init program in `Effect.provide` for cluster services — that
would tear the layer down when init returns. The handle also exposes the four
native namespace bindings (`entityNamespace`, `workflowNamespace`,
`queueNamespace`, `singletonNamespace`) as escape hatches. These bindings and
`context` are runtime-only; reading them during plan evaluation throws a
diagnostic. During planning, `provide` passes through its Effect and `wake`
does nothing.

A complete runnable example (one entity, one singleton, one Cron Trigger)
lives at [`examples/alchemy`](./examples/alchemy).

### Manual live smoke

The live deployment smoke has not yet been verified.

Alchemy tracks the published `effect` release, so CI covers this integration
with typechecks only (plus the manual `Alchemy Canary` workflow against the
latest `alchemy@beta`). After changing the integration, run one live smoke
with Cloudflare credentials configured:

1. `cd packages/platform/cloudflare/examples/alchemy`
2. `alchemy deploy` — expect the Worker plus the four SQLite-backed Durable
   Object classes (`ClusterEntity`, `ClusterWorkflow`, `ClusterDurableQueue`,
   `ClusterSingleton`) and the `0 * * * *` Cron Trigger.
3. `curl https://<worker-url>/counter-1` twice — expect `1` then `2`.
4. Trigger the cron (or wait for the top of the hour) and check the Worker
   logs for `Running hourly maintenance`.
5. `alchemy destroy` to clean up.

## Worker routes

The existing `EntityProxy` / `EntityProxyServer` and `WorkflowProxy` /
`WorkflowProxyServer` modules remain the route helpers. Define an HTTP or RPC
surface with the proxy module, then provide its server layer with
`CloudflareCluster.layer`. Entity proxy handlers call `Entity.client`, and
workflow proxy handlers call the workflow API, so the Cloudflare layers encode
the entity or workflow name and resolve the corresponding Durable Object stub.
There is no runner-fleet proxy on this path.

These are Worker routes, not Durable Object routes. The Durable Object classes
are internal transport: they trust the same-Worker namespace bindings and must
not be exposed on a public route. HTTP or RPC authentication and authorization
are user code on the Worker.

## Data location

To keep cluster Durable Objects inside a
[jurisdiction](https://developers.cloudflare.com/durable-objects/reference/data-location/),
pass jurisdiction subnamespaces (for example `env.CLUSTER_ENTITY.jurisdiction("eu")`)
for all four bindings to `CloudflareCluster.layer`, or pass `jurisdiction: "eu"`
to `AlchemyCloudflareCluster.make`. Under local `wrangler dev`, calling
`.jurisdiction(...)` throws in `workerd` before `CloudflareCluster.layer` receives
the binding, so pass the four unscoped bindings for local development; only
`AlchemyCloudflareCluster.make` falls back automatically to unrestricted bindings
for `workerd`'s unsupported-jurisdiction error (and rethrows other failures).
Internal peer lookups through `ctx.exports` automatically stay in the calling
object's `ctx.id.jurisdiction`. Opting into a jurisdiction does not migrate
existing objects or remove unrestricted twins with the same name.

## Long waits and delivery

- A long ask pins the caller. A delayed ask made directly by a Worker also
  keeps the destination RPC open, so it pins the destination too.
- Caller eviction or deployment drops the in-memory wait even though the
  destination may still run the persisted request.
- Prefer a tell when no response is needed. For durable long waits, prefer a
  workflow with `DurableClock` and `DurableDeferred`.
- Stream asks with a future `DeliverAt` are outside v1.

## Handler concurrency

`Entity.toLayer(..., { concurrency })` applies inside the entity Durable
Object. The default of 1 runs one handler at a time, a number allows that many
in-flight handlers per entity, and `"unbounded"` removes the limit. Durable
Object isolates are single-threaded, so this is interleaving of suspended
handlers, not parallelism.

- Envelope decode, persist-before-run, dedupe, duplicate resume, and alarm
  arming stay serialized at any setting.
- With `concurrency` above 1, strict mailbox ordering holds per permit, the
  same as the classic runner path: in-flight handlers interleave at every
  suspension point.
- An ask cycle (entity A asks B while B's handler asks A back) needs
  `concurrency` of at least 2 on the entity receiving the second ask. At the
  default of 1 the cycle deadlocks, matching the classic contract.
- Replayed mailbox rows and alarm-due runs draw from the same budget as live
  requests.

`defectRetryPolicy` and `spanAttributes` also apply inside the entity Durable
Object. `disableFatalDefects`, `maxIdleTime`, and `mailboxCapacity` are
accepted for parity and have no effect. Hibernation owns idle entities, and the
mailbox capacity is fixed at 4096.

Defects on this path are always request-local, as if `disableFatalDefects`
were `true`. A handler defect is retried under `defectRetryPolicy` when one is
set, then the request gets a terminal defect reply and the handlers are
rebuilt. Other in-flight requests finish on the build they started on and are
not replayed.

## Entity SQL storage

Each entity Durable Object provides `CloudflareCluster.DurableObjectSqlClient`
to its handler build and handlers: an `SqlClient` on the object's own SQLite
storage. It is a separate tag, so an app-wide `SqlClient` from the Worker layer
(a D1 database, say) keeps working inside the handlers.

Register the handlers with `Entity.toLayer` and read the client with
`CloudflareCluster.DurableObjectSqlClient.orDie` in the build. `orDie` has no
requirements, so the layer needs nothing extra. Yielding
`DurableObjectSqlClient` directly would leave it as a layer requirement.
Handlers registered with `Entity.toLayerQueue` get the client the same way.

```ts
import { CloudflareCluster } from "@effect/platform-cloudflare"
import { Effect, Schema } from "effect"
import { Entity } from "effect/cluster"
import { Rpc } from "effect/rpc"

const Journal = Entity.make("Journal", [
  Rpc.make("Append", { payload: { entries: Schema.Array(Schema.String) } }),
  Rpc.make("List", { success: Schema.Array(Schema.String) })
])

const build = Effect.gen(function*() {
  const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
  yield* sql`CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)`
  return Journal.of({
    // Every entry commits together, or none do.
    Append: ({ payload }) =>
      sql.withTransaction(
        Effect.forEach(payload.entries, (entry) => sql`INSERT INTO journal (entry) VALUES (${entry})`)
      ).pipe(Effect.asVoid, Effect.orDie),
    List: () =>
      sql<{ readonly entry: string }>`SELECT entry FROM journal ORDER BY seq`.pipe(
        Effect.map((rows) => rows.map((row) => row.entry)),
        Effect.orDie
      )
  })
}).pipe(Effect.orDie)

const JournalLayer = Journal.toLayer(build)
```

To run code written against `SqlClient.SqlClient`, such as `SqlSchema` or
`Model.makeRepository`, provide the entity client as that service locally:
`Effect.provideService(effect, SqlClient.SqlClient, sql)`.

- `orDie` dies on the first handler build when no `DurableObjectSqlClient` is
  provided, such as outside an entity Durable Object or in a test without a
  SQL layer.
- Rows live and die with the entity's Durable Object. They cannot be queried
  from outside it or from another entity.
- Tables whose names start with `cluster_` are reserved. The entity mailbox
  uses `cluster_messages` and `cluster_replies`, and `reset` / `clearReplies`
  only touch those tables.
- A row cannot exceed 2 MB, the same SQLite ceiling as an encoded message.
- A storage transaction closes the Durable Object's input gate until it
  finishes. Timers and I/O awaited inside `withTransaction` never resume, so
  keep transactions to SQL work.
- Mailbox writes wait for an open transaction to finish, so a rollback never
  takes another handler's stored reply with it.

To test the handlers, run the same layer with `Entity.makeTestClient`,
providing `DurableObjectSqlClient` from any SQL layer, for example an
in-memory `@effect/sql-sqlite-node` client:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { Entity, ShardingConfig } from "effect/cluster"
import { SqlClient } from "effect/sql"

const EntitySqlTest = Layer.effect(
  CloudflareCluster.DurableObjectSqlClient,
  Effect.service(SqlClient.SqlClient)
).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" })))

const program = Effect.gen(function*() {
  const makeClient = yield* Entity.makeTestClient(Journal, JournalLayer)
  const journal = yield* makeClient("one")
  yield* journal.Append({ entries: ["a", "b"] })
  return yield* journal.List()
}).pipe(
  Effect.scoped,
  Effect.provide(Layer.merge(ShardingConfig.layer(), EntitySqlTest))
)
```

## Restarts and recovery

A deploy, a runtime update, or an eviction kills the entity Durable Object.
Cloudflare does not re-create it by itself: the object stays cold until a
request, an alarm, or a WebSocket event arrives. To recover without outside
contact, the entity keeps an alarm in storage while it has something to come
back for:

- While it holds `Entity.keepAlive`, the alarm re-arms every
  `keepAliveHeartbeat` interval (30 seconds by default, set on
  `CloudflareCluster.layer` or `AlchemyCloudflareCluster.make`). After a
  restart the alarm rebuilds the entity, which runs its handler build, and
  restores the hold. `Entity.keepAlive(false)` ends it.
- While a persisted request runs, the alarm stays armed one interval ahead.
  After a restart it replays every unprocessed row, so an interrupted request
  runs again without a new message. Replay is alarm-driven; any later request
  to the entity replays the rows too.

The interval is recovery latency, not a liveness check. At 30 seconds a
kept-alive entity costs about 2,880 alarm requests a day, which is small next
to the duration billing of the held object itself.

Things to plan for:

- After a deploy, kept-alive entities keep running the old code for about 5
  minutes, then die without warning. Schema changes must tolerate old code
  still running against the same storage.
- Recovery after a deploy takes about those 5 minutes plus one interval. The
  hold cannot see the deploy; only the heartbeat brings the entity back.
- The keep-alive flag is persisted, the holder count is not. Each handler
  build counts its own holders, so two `EntityResource`s need two releases.
  Classic cluster drops the hold when the first one releases.
- An `EntityResource` that is not acquired eagerly in the handler build
  leaves the object pinned after a restart until a later
  `Entity.keepAlive(false)`. Classic cluster behaves the same.
- A deploy that removes an entity type leaves its heartbeat behind. The alarm
  fails, Cloudflare retries it 6 times, and the chain stops; the stored
  keep-alive flag is never cleaned up.

## v1 compatibility

The status vocabulary is **maps 1:1**, **adapted**, and **out of scope**.

| Capability                                                                    | Status       | Rationale                                                                                                   |
| ----------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------- |
| `Entity` + `RpcGroup` definition                                              | adapted      | Same definition; handlers register at Worker init onto one shared Durable Object class                      |
| `Entity.client` / location-transparent ask-tell                               | adapted      | Worker encodes `(type, id)` and calls `getByName`; there is no `ShardId` routing                            |
| `EntityProxy` / `EntityProxyServer` and workflow equivalents                  | adapted      | Worker route helpers encode the name and stub the Durable Object through the Cloudflare layers              |
| Non-`Persisted` RPC                                                           | adapted      | Best-effort in-request only; it can be lost on hibernation or a crash                                       |
| `Persisted` ask/tell + mailbox                                                | adapted      | Per-entity Durable Object SQLite, persist-before-run, and uuidv7 request ids                                |
| `PrimaryKey` dedupe / `Duplicate` resume                                      | maps 1:1     | Same contract                                                                                               |
| Stream ask `Chunk` / `AckChunk` / `lastSentChunk` / `WithExit`                | maps 1:1     | Same reply protocol on Durable Object storage                                                               |
| `clearReplies` / `reset`                                                      | maps 1:1     | Same re-run semantics                                                                                       |
| `DeliverAt` mailbox delivery                                                  | adapted      | Destination due column and alarm instead of storage polling                                                 |
| Ask + future `DeliverAt`                                                      | adapted      | Destination may hibernate through `replyTo`; ask pins its caller, and a Worker ask pins the destination too |
| Worker to Durable Object transport failures                                   | adapted      | Typed `PersistenceError`; persisted requests retry retryable errors on a fresh stub, others fail at once    |
| `MailboxFull` / 4096 cap / 2 MB row rejection                                 | maps 1:1     | Same limits; the SQLite row is the hard ceiling                                                             |
| `defectRetryPolicy` then terminal defect                                      | adapted      | Rebuilds handlers in the wake; crash or deployment wipes memory and replays unprocessed rows                |
| `Entity.toLayer` `concurrency`                                                | maps 1:1     | Same per-entity handler interleaving contract; storage entry stays serialized at any setting                |
| `Entity.keepAlive`                                                            | maps 1:1     | Survives restarts through a heartbeat alarm; the holder count is per handler build, not persisted           |
| `CurrentRunnerAddress`                                                        | adapted      | Synthetic address for identity and telemetry; no peer dialing                                               |
| `EntityResource.make`                                                         | adapted      | External lifetimes such as a browser; close or idle TTL unpins                                              |
| `DurableObjectSqlClient` in entity handlers (`Entity.toLayer` + `orDie`)      | adapted      | The entity Durable Object's own SQLite; `cluster_` tables reserved, 2 MB rows, transactions per object      |
| `EntityResource.makeK8sPod`                                                   | out of scope | Requires `K8sHttpClient`                                                                                    |
| `Workflow` / `Activity` / `DurableDeferred` user APIs                         | maps 1:1     | Unchanged; the engine behind them changes                                                                   |
| `CloudflareWorkflowEngine` (`WorkflowEngine.Encoded`)                         | adapted      | Dedicated workflow Durable Object, SQLite, and one alarm                                                    |
| `DurableClock`                                                                | adapted      | Always durable; there is no short in-memory timer path                                                      |
| `DurableQueue`                                                                | adapted      | One Durable Object per queue name with SQLite and an alarm watchdog                                         |
| `PersistedQueue.layerCleanup`                                                 | out of scope | Fails explicitly; namespace bindings cannot enumerate queue objects. Completed rows are retained for dedup. |
| `Singleton`                                                                   | adapted      | Named Durable Object; runs once per wake and then may hibernate                                             |
| `ClusterCron`                                                                 | adapted      | Per-fire entity ids, `DeliverAt` destination alarms, and a singleton seed                                   |
| Address `(EntityType, EntityId)`                                              | adapted      | Length-prefixed Durable Object name; cold first contact is normal                                           |
| `Sharding.getSnowflake`                                                       | out of scope | Dies; isolates have no fleet-unique machine id. Request ids are uuidv7                                      |
| `ShardId` / shard locks / runner ring                                         | out of scope | One-instance-per-id replaces ownership                                                                      |
| `MessageStorage` / `RunnerStorage` / `RunnerHealth` / `Runners` as user seams | out of scope | The Durable Object path owns persistence and alarms internally                                              |
| `HttpRunner` / `SocketRunner` / peer runner fleet                             | out of scope | Worker edge only                                                                                            |
| `EntityReaper` / `maxIdleTime`                                                | out of scope | Cloudflare hibernation owns sleep; `keepAlive` holders provide pinning                                      |
| Activate/deactivate / shard handoff / `EntityNotAssignedToRunner`             | out of scope | Whole-wake handlers with no handoff                                                                         |
| Park-and-replay caller hibernation                                            | out of scope | Not part of v1                                                                                              |
| Stream ask + future `DeliverAt`                                               | out of scope | Delayed asks support non-stream `WithExit` only                                                             |
| External SQL as the system of record                                          | out of scope | Durable Object SQLite is the system of record                                                               |
| Non-Worker long-lived runners as a first-class edge                           | out of scope | The Worker is the supported edge model                                                                      |

## Tracing

`CloudflareTracer` records Effect spans in the trace Cloudflare already collects for each Worker invocation. Effect spans show up next to the runtime's own `fetch`, KV, D1 and other binding spans, and the runtime spans nest under the Effect span that made the call. Cloudflare exports the trace to the destinations configured for the account, so there is no endpoint, exporter or flush to set up in the Worker.

Turn traces on in the Wrangler configuration:

```jsonc
// wrangler.jsonc
{
  "observability": {
    "traces": { "enabled": true },
  },
}
```

Then provide the tracer layer. It uses `tracing` from `cloudflare:workers`, so there is nothing to pass in. The same layer works in Worker handlers and in Durable Objects.

```ts
import { CloudflareTracer } from "@effect/platform-cloudflare"
import { Effect, ManagedRuntime } from "effect"

const runtime = ManagedRuntime.make(CloudflareTracer.layer)

export default {
  fetch: (request: Request, env: Env) =>
    runtime.runPromise(
      Effect.promise(() => env.USERS.get("user:42")).pipe(
        Effect.map((user) => Response.json(user)),
        Effect.withSpan("load-user", { attributes: { "user.id": 42 } })
      )
    )
}
```

The tracer needs `tracing.startSpan` and `tracing.withActiveSpan`. `withActiveSpan` arrived in workerd `1.20261113.1` and is not in Cloudflare's custom spans docs yet. `@cloudflare/workers-types` types it from `5.20261107.1`, and local development needs a Wrangler or Miniflare release that bundles workerd `1.20261113.1` or later.

The tracer also needs `AsyncLocalStorage` from `process.getBuiltinModule`. Workers provide it with the `nodejs_compat` flag, or with a `compatibility_date` of `2026-08-04` or later. Building the tracer layer fails without it.

Cloudflare's spans are simpler than Effect's, so some span data does not carry over:

- A span's Cloudflare parent comes from the async context. An Effect span created with `root: true`, or under a parent from another tracer such as an incoming `traceparent`, still nests under the active Cloudflare span.
- Cloudflare spans have no events, links, kind or explicit timestamps. Span events are dropped, links and kind stay on the Effect span, and Cloudflare records the timing.
- Unsampled Effect spans, such as spans below `Tracer.MinimumTraceLevel`, are not recorded. Work inside them nests under the nearest recorded span.
- A Cloudflare span belongs to the invocation that created it. An Effect span that outlives its invocation, such as a `Layer.span` in a module-level `ManagedRuntime`, stops recording, and spans created under it in later invocations nest under that invocation's root span.
- A Durable Object does not reject spans from its earlier requests, so there spans created under such a span join the earlier request's trace, which has already been sent, and are lost. Avoid long-lived parent spans, such as a `Layer.span`, in a runtime shared across a Durable Object's requests.
- Sampling is Effect's decision and recording is Cloudflare's. A span Cloudflare does not record gets random ids, so an outgoing `traceparent` can be marked sampled in an invocation Cloudflare records nothing for.

Use `Otlp.layer` with `FetchHttpClient` instead if you want the Worker to send its own trace to an OTLP endpoint. That trace is separate from Cloudflare's, and the Worker has to flush it before each invocation ends.

## Documentation

- [Effect website](https://effect.website)
