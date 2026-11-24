import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster"
import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects"
import { ClusterEntity as BaseClusterEntity } from "@effect/platform-cloudflare/CloudflareDurableObjects"
export {
  ClusterDurableQueue,
  ClusterSingleton,
  ClusterWorkflow
} from "@effect/platform-cloudflare/CloudflareDurableObjects"
import type { Context } from "effect"
import {
  Cause,
  Cron,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  PrimaryKey,
  Schedule,
  Schema,
  Scope,
  Stream
} from "effect"
import { ClusterCron, ClusterSchema, DeliverAt, Entity, EntityResource, Singleton } from "effect/cluster"
import { Rpc, RpcSchema } from "effect/rpc"
import { Activity, DurableClock, DurableDeferred, DurableQueue, Workflow } from "effect/workflow"

// ---------------------------------------------------------------------------
// Observable module state. It lives in the Worker isolate, is shared with the
// Durable Objects (same isolate), and is wiped by a Miniflare restart.
// ---------------------------------------------------------------------------

const counts = {
  builds: new Map<string, number>(),
  values: new Map<string, number>(),
  entered: new Map<string, number>(),
  completed: new Map<string, number>(),
  interrupted: new Map<string, number>(),
  attempts: new Map<string, number>(),
  activeHolds: new Map<string, number>(),
  workflowRuns: new Map<string, number>(),
  activityRuns: new Map<string, number>(),
  queueRuns: new Map<string, number>()
}
const deliveries = new Map<string, Array<{ readonly deliverAt: number; readonly deliveredAt: number }>>()
const singleton = { starts: 0, active: 0, maxActive: 0, done: 0 }
const resource = { acquired: 0, released: 0 }
const ticks: Array<{ readonly at: number; readonly scheduled: string }> = []

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)

const gates = new Map<string, Latch.Latch>()
const gateFor = (key: string) => {
  let gate = gates.get(key)
  if (gate === undefined) {
    gate = Latch.makeUnsafe(false)
    gates.set(key, gate)
  }
  return gate
}

const serializeState = () => ({
  builds: Object.fromEntries(counts.builds),
  values: Object.fromEntries(counts.values),
  entered: Object.fromEntries(counts.entered),
  completed: Object.fromEntries(counts.completed),
  interrupted: Object.fromEntries(counts.interrupted),
  attempts: Object.fromEntries(counts.attempts),
  activeHolds: Object.fromEntries(counts.activeHolds),
  workflowRuns: Object.fromEntries(counts.workflowRuns),
  activityRuns: Object.fromEntries(counts.activityRuns),
  queueRuns: Object.fromEntries(counts.queueRuns),
  deliveries: Object.fromEntries(deliveries),
  singleton,
  resource,
  ticks
})

// ---------------------------------------------------------------------------
// Test observation seam on the entity Durable Object: expose mailbox rows, the
// armed alarm, and active keep-alive holds without touching handler code.
// ---------------------------------------------------------------------------

type EntityCtor = ConstructorParameters<typeof BaseClusterEntity>
type MailboxRow = {
  readonly message_id: string | null
  readonly processed: number
  readonly deliver_at: number | null
}

export class ClusterEntity extends BaseClusterEntity {
  readonly #name: string
  readonly #storage: EntityCtor[0]["storage"]

  constructor(ctx: EntityCtor[0], environment: EntityCtor[1]) {
    super(ctx, environment)
    this.#name = ctx.id.name ?? ""
    this.#storage = ctx.storage
  }

  mailboxRows(): Array<MailboxRow> {
    return this.#storage.sql.exec<MailboxRow>(
      "SELECT message_id, processed, deliver_at FROM cluster_messages ORDER BY rowid ASC"
    ).toArray()
  }

  getAlarm(): Promise<number | null> {
    return this.#storage.getAlarm()
  }

  override async hold(): Promise<void> {
    bump(counts.activeHolds, this.#name)
    try {
      await super.hold()
    } finally {
      counts.activeHolds.set(this.#name, (counts.activeHolds.get(this.#name) ?? 1) - 1)
    }
  }
}

// ---------------------------------------------------------------------------
// Entities, defined and registered through the public API only.
// ---------------------------------------------------------------------------

class ScheduledPayload extends Schema.Class<ScheduledPayload>("ScheduledPayload")({
  deliverAt: Schema.Number,
  op: Schema.String
}) {
  [PrimaryKey.symbol]() {
    return this.op
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.deliverAt)
  }
}

const Counter = Entity.make("Counter", [
  Rpc.make("Increment", {
    payload: { op: Schema.String },
    primaryKey: ({ op }) => op,
    success: Schema.Number
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("IncrementVolatile", { success: Schema.Number }),
  Rpc.make("Get", { success: Schema.Number }),
  Rpc.make("FailTyped", { error: Schema.String, success: Schema.String }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Defect", { success: Schema.String }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Watch", { success: RpcSchema.Stream(Schema.Number, Schema.Never) }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("ScheduledIncrement", { payload: ScheduledPayload, success: Schema.Number }).annotate(
    ClusterSchema.Persisted,
    true
  ),
  Rpc.make("StoreBig", {
    payload: { data: Schema.String },
    primaryKey: ({ data }) => String(data.length),
    success: Schema.Number
  }).annotate(ClusterSchema.Persisted, true)
])

const increment = (entityId: string) => {
  const value = (counts.values.get(entityId) ?? 0) + 1
  counts.values.set(entityId, value)
  return value
}

const CounterLayer = Counter.toLayer(
  Effect.sync(() => {
    bump(counts.builds, "Counter")
    return Counter.of({
      Increment: (request) => Effect.sync(() => increment(request.address.entityId)),
      IncrementVolatile: (request) => Effect.sync(() => increment(request.address.entityId)),
      Get: (request) => Effect.sync(() => counts.values.get(request.address.entityId) ?? 0),
      FailTyped: (request) => Effect.fail(`typed:${request.address.entityId}`),
      Defect: (request) => Effect.die(`defect:${request.address.entityId}`),
      Watch: () => Stream.fromIterable([1, 2, 3]).pipe(Stream.rechunk(1)),
      ScheduledIncrement: (request) =>
        Effect.sync(() => {
          const entityId = request.address.entityId
          const entries = deliveries.get(entityId) ?? []
          deliveries.set(entityId, [
            ...entries,
            { deliverAt: request.payload.deliverAt, deliveredAt: Date.now() }
          ])
          return increment(entityId)
        }),
      StoreBig: (request) => Effect.sync(() => request.payload.data.length)
    })
  })
)

// Persisted requests that block on a gate, for restart/replay scenarios.
// Unbounded concurrency lets control requests interleave with blocked Holds.
const Blocker = Entity.make("Blocker", [
  Rpc.make("Hold", {
    payload: { op: Schema.String },
    primaryKey: ({ op }) => op,
    success: Schema.Number
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Get", { success: Schema.Number }),
  Rpc.make("Pin", { success: Schema.String }),
  Rpc.make("Unpin", { success: Schema.String }),
  Rpc.make("ScheduledIncrement", { payload: ScheduledPayload, success: Schema.Number }).annotate(
    ClusterSchema.Persisted,
    true
  ),
  // Opens the gate from inside the entity Durable Object, so the resumed
  // handler continues in a request context that may touch this object's
  // storage (a Worker-side open would resume it in a foreign context).
  Rpc.make("Open", { payload: { op: Schema.String }, success: Schema.String })
])

const BlockerLayer = Blocker.toLayer(
  Effect.sync(() => {
    bump(counts.builds, "Blocker")
    return Blocker.of({
      Pin: () => Effect.as(Entity.keepAlive(true), "pinned"),
      Unpin: () => Effect.as(Entity.keepAlive(false), "unpinned"),
      ScheduledIncrement: (request) =>
        Effect.sync(() => {
          const entityId = request.address.entityId
          deliveries.set(entityId, [
            ...(deliveries.get(entityId) ?? []),
            { deliverAt: request.payload.deliverAt, deliveredAt: Date.now() }
          ])
          return increment(entityId)
        }),
      Hold: Effect.fnUntraced(function*(request) {
        const key = `${request.address.entityId}/${request.payload.op}`
        bump(counts.entered, key)
        yield* gateFor(key).await
        bump(counts.completed, key)
        return increment(request.address.entityId)
      }),
      Get: (request) => Effect.sync(() => counts.values.get(request.address.entityId) ?? 0),
      Open: (request) =>
        Effect.sync(() => {
          gateFor(`${request.address.entityId}/${request.payload.op}`).openUnsafe()
          return "opened"
        })
    })
  }),
  { concurrency: "unbounded" }
)

// Serialized entity for cancellation and permit-cleanup scenarios.
const Serial = Entity.make("Serial", [
  Rpc.make("HoldVolatile", { payload: { key: Schema.String }, success: Schema.String }),
  Rpc.make("HoldUninterruptible", { payload: { key: Schema.String }, success: Schema.String }).annotate(
    ClusterSchema.Uninterruptible,
    true
  ),
  Rpc.make("Quick", { success: Schema.String })
])

const SerialLayer = Serial.toLayer({
  HoldVolatile: Effect.fnUntraced(function*(request) {
    const key = request.payload.key
    bump(counts.entered, key)
    yield* gateFor(key).await.pipe(
      Effect.onInterrupt(() => Effect.sync(() => bump(counts.interrupted, key)))
    )
    bump(counts.completed, key)
    return "done"
  }),
  HoldUninterruptible: Effect.fnUntraced(function*(request) {
    const key = request.payload.key
    bump(counts.entered, key)
    yield* gateFor(key).await
    bump(counts.completed, key)
    return "done"
  }),
  Quick: () => Effect.succeed("ok")
})

// Entity whose handler always dies, with a bounded defect retry policy.
const Flaky = Entity.make("Flaky", [
  Rpc.make("Boom", {
    payload: { op: Schema.String },
    primaryKey: ({ op }) => op,
    success: Schema.String
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("Ping", { success: Schema.String })
])

const FlakyLayer = Flaky.toLayer(
  Effect.sync(() => {
    bump(counts.builds, "Flaky")
    return Flaky.of({
      Boom: (request) =>
        Effect.suspend(() => {
          bump(counts.attempts, `${request.address.entityId}/${request.payload.op}`)
          return Effect.die(`boom:${request.address.entityId}`)
        }),
      Ping: () => Effect.succeed("pong")
    })
  }),
  { defectRetryPolicy: Schedule.recurs(2) }
)

// Entity whose handler asks another entity through the public client.
// `AskScheduled` makes a delayed ask from inside an entity, so the reply is
// delivered back to this entity's Durable Object through `replyTo`.
const Relay = Entity.make("Relay", [
  Rpc.make("AskCounter", { payload: { target: Schema.String }, success: Schema.Number }),
  Rpc.make("AskScheduled", { payload: { target: Schema.String }, success: Schema.Number })
])

const RelayLayer = Relay.toLayer(
  Effect.gen(function*() {
    const makeCounter = yield* Counter.client
    return Relay.of({
      AskCounter: (request) => Effect.orDie(makeCounter(request.payload.target).Get(void 0)),
      AskScheduled: (request) =>
        Effect.orDie(
          makeCounter(request.payload.target).ScheduledIncrement(
            new ScheduledPayload({ deliverAt: Date.now() + 300, op: "relayed" })
          )
        )
    })
  })
)

// Keep-alive pinning driven from inside handlers via the public API.
const Pinned = Entity.make("Pinned", [
  Rpc.make("Pin", { success: Schema.String }),
  Rpc.make("Unpin", { success: Schema.String })
])

// Builds are counted per entity id, so a restart test can see whether a
// keep-alive entity was rebuilt without messaging it.
const PinnedLayer = Pinned.toLayer(
  Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    bump(counts.builds, `Pinned/${address.entityId}`)
    return Pinned.of({
      Pin: () => Effect.as(Entity.keepAlive(true), "pinned"),
      Unpin: () => Effect.as(Entity.keepAlive(false), "unpinned")
    })
  })
)

const Holder = Entity.make("Holder", [
  Rpc.make("Get", { success: Schema.Number }),
  Rpc.make("Close", { success: Schema.String })
])

const HolderLayer = Holder.toLayer(
  Effect.gen(function*() {
    const held = yield* EntityResource.make({
      acquire: Effect.acquireRelease(
        Effect.sync(() => ++resource.acquired),
        () => Effect.sync(() => void resource.released++)
      ),
      idleTimeToLive: "400 millis"
    })
    return Holder.of({
      Get: () => Effect.scoped(held.get),
      Close: () => Effect.as(held.close, "closed")
    })
  })
)

// Entity that keeps its own rows in the entity Durable Object's SQLite through
// `DurableObjectSqlClient`. `Append` writes every entry in one transaction and
// fails after the writes when asked to, so a rollback is observable.
const Journal = Entity.make("Journal", [
  Rpc.make("Append", {
    payload: { entries: Schema.Array(Schema.String), fail: Schema.Boolean },
    success: Schema.Number,
    error: Schema.String
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("List", { success: Schema.Array(Schema.String) })
])

const JournalLayer = Journal.toLayer(
  Effect.gen(function*() {
    const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
    yield* sql`CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry TEXT NOT NULL)`
    return Journal.of({
      Append: ({ payload }) =>
        sql.withTransaction(Effect.gen(function*() {
          for (const entry of payload.entries) {
            yield* sql`INSERT INTO journal (entry) VALUES (${entry})`
          }
          if (payload.fail) return yield* Effect.fail("rejected")
          return payload.entries.length
        })).pipe(Effect.catchTag("SqlError", Effect.die)),
      List: () =>
        sql<{ readonly entry: string }>`SELECT entry FROM journal ORDER BY seq`.pipe(
          Effect.map((rows) => rows.map((row) => row.entry)),
          Effect.orDie
        )
    })
  }).pipe(Effect.orDie)
)

// Two handlers of one entity, interleaved through a user transaction. `Wait`
// blocks on a deferred that `ReleaseThenFail` completes from inside its
// transaction, which then rolls back. `Wait` resumes while the transaction is
// still open, so its stored reply must not land inside it.
const releases = new Map<string, Deferred.Deferred<void>>()
const releaseFor = (entityId: string) => {
  let release = releases.get(entityId)
  if (release === undefined) {
    release = Deferred.makeUnsafe<void>()
    releases.set(entityId, release)
  }
  return release
}

const Coordinated = Entity.make("Coordinated", [
  Rpc.make("Wait", {
    payload: { op: Schema.String },
    primaryKey: ({ op }) => op,
    success: Schema.String
  }).annotate(ClusterSchema.Persisted, true),
  Rpc.make("ReleaseThenFail", { error: Schema.String, success: Schema.String })
])

const CoordinatedLayer = Coordinated.toLayer(
  Effect.gen(function*() {
    const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
    yield* sql`CREATE TABLE IF NOT EXISTS coordinated (entry TEXT NOT NULL)`
    return Coordinated.of({
      Wait: Effect.fnUntraced(function*(request) {
        bump(counts.entered, `coordinated/${request.address.entityId}`)
        yield* Deferred.await(releaseFor(request.address.entityId))
        return "released"
      }),
      ReleaseThenFail: (request) =>
        sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO coordinated (entry) VALUES ('rolled back')`
          Deferred.doneUnsafe(releaseFor(request.address.entityId), Effect.void)
          // Microtask turns only: timers never fire inside a storage
          // transaction. They give the woken handler room to run.
          for (let i = 0; i < 50; i++) {
            yield* Effect.promise(() => Promise.resolve())
          }
          return yield* Effect.fail("rejected")
        })).pipe(Effect.catchTag("SqlError", Effect.die))
    })
  }).pipe(Effect.orDie),
  { concurrency: 2 }
)

// ---------------------------------------------------------------------------
// Workflows, durable clock/deferred, durable queue.
// ---------------------------------------------------------------------------

const EmailWorkflow = Workflow.make("EmailWorkflow", {
  payload: { id: Schema.String, value: Schema.Number },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id
})

const EmailWorkflowLayer = EmailWorkflow.toLayer(Effect.fnUntraced(function*({ id, value }) {
  bump(counts.workflowRuns, id)
  return yield* Activity.make({
    name: "Send",
    success: Schema.Number,
    execute: Effect.sync(() => {
      bump(counts.activityRuns, id)
      return value + 1
    })
  })
}))

const ClockWorkflow = Workflow.make("ClockWorkflow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id
})

const ClockWorkflowLayer = ClockWorkflow.toLayer(Effect.fnUntraced(function*({ id }) {
  bump(counts.workflowRuns, id)
  yield* DurableClock.sleep({ name: "wake", duration: "600 millis" })
  return Date.now()
}))

const Door = DurableDeferred.make("Door", { success: Schema.String })

const DoorWorkflow = Workflow.make("DoorWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id
})

const DoorWorkflowLayer = DoorWorkflow.toLayer(Effect.fnUntraced(function*({ id }) {
  bump(counts.workflowRuns, id)
  return yield* DurableDeferred.await(Door)
}))

const Queue = DurableQueue.make({
  name: "IntegrationQueue",
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id
})

const QueueWorkflow = Workflow.make("QueueWorkflow", {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id
})

const QueueWorkflowLayer = QueueWorkflow.toLayer(({ id }) => DurableQueue.process(Queue, { id }))

// ---------------------------------------------------------------------------
// Singleton and ClusterCron.
// ---------------------------------------------------------------------------

const SingletonLayer = Singleton.make(
  "integration-singleton",
  Effect.gen(function*() {
    singleton.starts++
    singleton.active++
    singleton.maxActive = Math.max(singleton.maxActive, singleton.active)
    yield* gateFor("singleton").await
    singleton.active--
    singleton.done++
  })
)

const CronLayer = ClusterCron.make({
  name: "integration-cron",
  cron: Cron.parseUnsafe("* * * * * *", "UTC"),
  execute: Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    ticks.push({ at: Date.now(), scheduled: address.entityId })
  })
})

// ---------------------------------------------------------------------------
// Layer assembly. workerd forbids timers and randomness in global scope, so
// the layer is built lazily inside the first event. The public Durable Object
// initializer blocks every class on the same build promise.
// ---------------------------------------------------------------------------

const makeAppLayer = (env: Record<string, any>) =>
  Layer.mergeAll(
    CounterLayer,
    BlockerLayer,
    SerialLayer,
    FlakyLayer,
    RelayLayer,
    PinnedLayer,
    HolderLayer,
    JournalLayer,
    CoordinatedLayer,
    EmailWorkflowLayer,
    ClockWorkflowLayer,
    DoorWorkflowLayer,
    QueueWorkflowLayer,
    SingletonLayer,
    CronLayer
  ).pipe(
    Layer.provideMerge(CloudflareCluster.layer({
      keepAliveHeartbeat: env.KEEP_ALIVE_HEARTBEAT ?? "1 second",
      entities: [Counter, Blocker, Serial, Flaky, Relay, Pinned, Holder, Journal, Coordinated],
      entityNamespace: env.CLUSTER_ENTITY,
      workflowNamespace: env.CLUSTER_WORKFLOW,
      queueNamespace: env.CLUSTER_QUEUE,
      singletonNamespace: env.CLUSTER_SINGLETON
    }))
  ) as Layer.Layer<any>

let bindings: Record<string, any>
let appContextPromise: Promise<Context.Context<any>> | undefined
const ensureApp = (env: unknown) => {
  bindings = env as Record<string, any>
  appContextPromise ??= Effect.runPromise(
    Effect.flatMap(Scope.make(), (scope) => Layer.buildWithScope(makeAppLayer(bindings), scope))
  )
  return appContextPromise
}

let initializationStarted = false
let initializationStartedAt: number | undefined
let initializationCompleted = false
let initializationFailure = false
let initializationOpen = true
const initializationCallsStarted = new Set<string>()
const initializationCallsCompleted = new Set<string>()
const isInitializationOpen = () => initializationOpen
const waitForInitializationControl = () =>
  (scheduler as unknown as { readonly wait: (delay: number) => Promise<void> }).wait(1)

const blockInitialization = () => {
  initializationStarted = false
  initializationStartedAt = undefined
  initializationOpen = false
}

const initializeApp = CloudflareDurableObjects.setInitializer(async (env) => {
  initializationStarted = true
  initializationStartedAt = Date.now()
  if (initializationFailure) {
    throw new Error("deliberate Cloudflare application initialization failure")
  }
  while (!isInitializationOpen()) await waitForInitializationControl()
  const context = await ensureApp(env)
  initializationCompleted = true
  return context
})

const run = async <A, E>(effect: Effect.Effect<A, E, any>, env: unknown): Promise<A> =>
  Effect.runPromise(Effect.provideContext(Effect.scoped(effect), await initializeApp(env)) as Effect.Effect<A, E>)

// ---------------------------------------------------------------------------
// HTTP surface for the tests.
// ---------------------------------------------------------------------------

const waitFor = (check: () => boolean, timeoutMillis: number): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMillis
    while (!check()) {
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return true
  })

const until = (description: string, check: () => boolean, timeoutMillis = 5000): Effect.Effect<void> =>
  Effect.flatMap(waitFor(check, timeoutMillis), (settled) => settled ? Effect.void : Effect.die(new Error(description)))

const serializeExit = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? { _tag: "Success", value: exit.value }
    : { _tag: "Failure", cause: Cause.pretty(exit.cause) }

const callColdDurableObject = async (kind: string, env: Record<string, any>): Promise<void> => {
  switch (kind) {
    case "entity": {
      const id = "readiness"
      const stub = env.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName("Counter", id))
      await stub.invoke(
        JSON.stringify({
          _tag: "Request",
          requestId: crypto.randomUUID(),
          address: {
            shardId: { group: "default", id: 1 },
            entityType: "Counter",
            entityId: id
          },
          tag: "Get",
          payload: null,
          headers: {}
        }),
        false
      )
      return
    }
    case "workflow":
      await env.CLUSTER_WORKFLOW
        .getByName(CloudflareCluster.encodeName("EmailWorkflow", "readiness"))
        .run(JSON.stringify({ id: "readiness", value: 1 }), { discard: false })
      return
    case "queue":
      await env.CLUSTER_QUEUE
        .getByName(CloudflareCluster.encodeName("PersistedQueue", "readiness"))
        .offer("readiness", JSON.stringify({ id: "readiness" }))
      return
    case "singleton":
      await env.CLUSTER_SINGLETON.getByName("Singleton/integration-singleton").wake()
      return
    default:
      throw new Error(`unknown Durable Object kind: ${kind}`)
  }
}

const workflows = {
  email: {
    workflow: EmailWorkflow,
    payload: (params: URLSearchParams) => ({
      id: params.get("id")!,
      value: Number(params.get("value") ?? 1)
    })
  },
  clock: { workflow: ClockWorkflow, payload: (params: URLSearchParams) => ({ id: params.get("id")! }) },
  door: { workflow: DoorWorkflow, payload: (params: URLSearchParams) => ({ id: params.get("id")! }) },
  queue: { workflow: QueueWorkflow, payload: (params: URLSearchParams) => ({ id: params.get("id")! }) }
} as Record<string, {
  readonly workflow: any
  readonly payload: (params: URLSearchParams) => any
}>

const handle = Effect.fnUntraced(function*(url: URL) {
  const params = url.searchParams
  const id = params.get("id") ?? "default"
  switch (url.pathname) {
    case "/state":
      return serializeState()
    case "/gate/open": {
      gateFor(params.get("key")!).openUnsafe()
      return { opened: params.get("key") }
    }

    case "/counter/increment": {
      const makeClient = yield* Counter.client
      const client = makeClient(id)
      const op = params.get("op") ?? "op"
      if (params.get("discard") === "true") {
        yield* client.Increment({ op }, { discard: true })
        return { discarded: true }
      }
      return { value: yield* client.Increment({ op }) }
    }
    case "/counter/increment-volatile": {
      const makeClient = yield* Counter.client
      return { value: yield* makeClient(id).IncrementVolatile(void 0) }
    }
    case "/counter/get": {
      const makeClient = yield* Counter.client
      return { value: yield* makeClient(id).Get(void 0) }
    }
    case "/counter/fail": {
      const makeClient = yield* Counter.client
      return serializeExit(yield* Effect.exit(makeClient(id).FailTyped(void 0)))
    }
    case "/counter/defect": {
      const makeClient = yield* Counter.client
      return serializeExit(yield* Effect.exit(makeClient(id).Defect(void 0)))
    }
    case "/counter/watch": {
      const makeClient = yield* Counter.client
      const values = yield* Stream.runCollect(makeClient(id).Watch(void 0))
      return { values: Array.from(values) }
    }
    case "/counter/scheduled": {
      const makeClient = yield* Counter.client
      const payload = new ScheduledPayload({
        deliverAt: Date.now() + Number(params.get("offset") ?? 500),
        op: params.get("op") ?? "op"
      })
      if (params.get("discard") === "true") {
        yield* makeClient(id).ScheduledIncrement(payload, { discard: true })
        return { deliverAt: payload.deliverAt }
      }
      return { deliverAt: payload.deliverAt, value: yield* makeClient(id).ScheduledIncrement(payload) }
    }
    case "/counter/big": {
      const makeClient = yield* Counter.client
      const data = "x".repeat(Number(params.get("bytes") ?? 2_500_000))
      return serializeExit(yield* Effect.exit(makeClient(id).StoreBig({ data })))
    }
    case "/counter/first-contact": {
      const makeClient = yield* Counter.client
      const client = makeClient(id)
      const n = Number(params.get("n") ?? 8)
      const values = yield* Effect.all(
        Array.from({ length: n }, (_, index) => client.Increment({ op: `first-${index}` })),
        { concurrency: "unbounded" }
      )
      return { values: [...values].sort((a, b) => a - b) }
    }
    case "/counter/rows": {
      const stub = bindings.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName("Counter", id))
      return {
        rows: yield* Effect.promise(() => stub.mailboxRows()),
        alarm: yield* Effect.promise(() => stub.getAlarm())
      }
    }

    case "/blocker/hold": {
      const makeClient = yield* Blocker.client
      const payload = { op: params.get("op") ?? "op" }
      if (params.get("discard") === "false") {
        return { value: yield* makeClient(id).Hold(payload) }
      }
      yield* makeClient(id).Hold(payload, { discard: true })
      return { discarded: true }
    }
    case "/blocker/rows": {
      const stub = bindings.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName("Blocker", id))
      return {
        rows: yield* Effect.promise(() => stub.mailboxRows()),
        alarm: yield* Effect.promise(() => stub.getAlarm())
      }
    }
    case "/blocker/get": {
      const makeClient = yield* Blocker.client
      return { value: yield* makeClient(id).Get(void 0) }
    }
    case "/blocker/pin": {
      const makeClient = yield* Blocker.client
      return { value: yield* makeClient(id).Pin(void 0) }
    }
    case "/blocker/unpin": {
      const makeClient = yield* Blocker.client
      return { value: yield* makeClient(id).Unpin(void 0) }
    }
    case "/blocker/scheduled": {
      const makeClient = yield* Blocker.client
      const payload = new ScheduledPayload({
        deliverAt: Date.now() + Number(params.get("offset") ?? 8000),
        op: "scheduled"
      })
      yield* makeClient(id).ScheduledIncrement(payload, { discard: true })
      return { deliverAt: payload.deliverAt }
    }
    case "/blocker/open": {
      const makeClient = yield* Blocker.client
      return { value: yield* makeClient(id).Open({ op: params.get("op") ?? "op" }) }
    }

    case "/serial/cancel": {
      const makeClient = yield* Serial.client
      const client = makeClient(id)
      const key = `cancel/${id}`
      const fiber = yield* Effect.forkChild(client.HoldVolatile({ key }))
      yield* until(`The HoldVolatile handler for ${key} did not start`, () => (counts.entered.get(key) ?? 0) > 0)
      yield* Fiber.interrupt(fiber)
      yield* until(
        `The HoldVolatile handler for ${key} was not interrupted`,
        () => (counts.interrupted.get(key) ?? 0) > 0
      )
      const quick = yield* client.Quick(void 0)
      return {
        interrupted: counts.interrupted.get(key) ?? 0,
        completed: counts.completed.get(key) ?? 0,
        quick
      }
    }
    case "/serial/uninterruptible": {
      const makeClient = yield* Serial.client
      const client = makeClient(id)
      const key = `uninterruptible/${id}`
      const fiber = yield* Effect.forkChild(client.HoldUninterruptible({ key }))
      yield* until(`The HoldUninterruptible handler for ${key} did not start`, () => (counts.entered.get(key) ?? 0) > 0)
      yield* Fiber.interrupt(fiber)
      gateFor(key).openUnsafe()
      yield* until(
        `The HoldUninterruptible handler for ${key} did not run to completion after the client interrupt`,
        () => (counts.completed.get(key) ?? 0) > 0
      )
      const quick = yield* client.Quick(void 0)
      return { completed: counts.completed.get(key) ?? 0, quick }
    }

    case "/flaky/boom": {
      const makeClient = yield* Flaky.client
      return serializeExit(yield* Effect.exit(makeClient(id).Boom({ op: params.get("op") ?? "op" })))
    }
    case "/flaky/ping": {
      const makeClient = yield* Flaky.client
      return { value: yield* makeClient(id).Ping(void 0) }
    }

    case "/relay/ask": {
      const makeClient = yield* Relay.client
      return { value: yield* makeClient(id).AskCounter({ target: params.get("target")! }) }
    }
    case "/relay/scheduled": {
      const makeClient = yield* Relay.client
      return { value: yield* makeClient(id).AskScheduled({ target: params.get("target")! }) }
    }

    case "/pinned/pin": {
      const makeClient = yield* Pinned.client
      return { value: yield* makeClient(id).Pin(void 0) }
    }
    case "/pinned/unpin": {
      const makeClient = yield* Pinned.client
      return { value: yield* makeClient(id).Unpin(void 0) }
    }
    case "/holds": {
      const name = CloudflareCluster.encodeName(params.get("type") ?? "Pinned", id)
      return { holds: counts.activeHolds.get(name) ?? 0 }
    }

    case "/holder/get": {
      const makeClient = yield* Holder.client
      return { value: yield* makeClient(id).Get(void 0) }
    }
    case "/holder/close": {
      const makeClient = yield* Holder.client
      return { value: yield* makeClient(id).Close(void 0) }
    }

    case "/journal/append": {
      const makeClient = yield* Journal.client
      const entries = (params.get("entries") ?? "").split(",").filter((entry) => entry.length > 0)
      return serializeExit(
        yield* Effect.exit(makeClient(id).Append({ entries, fail: params.get("fail") === "true" }))
      )
    }
    case "/journal/list": {
      const makeClient = yield* Journal.client
      return { entries: yield* makeClient(id).List(void 0) }
    }

    case "/coordinated/release": {
      const makeClient = yield* Coordinated.client
      const client = makeClient(id)
      const wait = yield* Effect.forkChild(client.Wait({ op: "wait" }))
      yield* until(
        `The Wait handler for ${id} did not start`,
        () => (counts.entered.get(`coordinated/${id}`) ?? 0) > 0
      )
      const released = serializeExit(yield* Effect.exit(client.ReleaseThenFail(void 0)))
      const waited = yield* Fiber.join(wait)
      const stub = bindings.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName("Coordinated", id))
      return { released, waited, rows: yield* Effect.promise(() => stub.mailboxRows()) }
    }

    case "/queue/drain": {
      // Workers cannot run background consumers across requests, so the queue
      // worker runs inside this request until the target item is processed.
      const target = params.get("id")!
      const fiber = yield* Effect.forkChild(DurableQueue.makeWorker(Queue, ({ id: itemId }) =>
        Effect.sync(() => {
          bump(counts.queueRuns, itemId)
          return `processed:${itemId}`
        })))
      yield* until(
        `The queue worker did not process item ${target}`,
        () => (counts.queueRuns.get(target) ?? 0) >= 1,
        8000
      )
      yield* Fiber.interrupt(fiber)
      return { processed: counts.queueRuns.get(target) ?? 0 }
    }

    case "/workflow/execute": {
      const entry = workflows[params.get("name") as keyof typeof workflows]
      const payload = entry.payload(params) as any
      const executionId = yield* entry.workflow.executionId(payload)
      if (params.get("discard") === "true") {
        yield* entry.workflow.execute(payload, { discard: true })
        return { executionId }
      }
      return { executionId, result: yield* entry.workflow.execute(payload) }
    }
    case "/workflow/poll": {
      const entry = workflows[params.get("name") as keyof typeof workflows]
      const executionId = yield* entry.workflow.executionId(entry.payload(params) as any)
      const result = yield* entry.workflow.poll(executionId)
      return Option.match(result as Option.Option<{ _tag: string; exit: Exit.Exit<unknown, unknown> }>, {
        onNone: () => ({ _tag: "None" }),
        onSome: (value) =>
          value._tag === "Complete"
            ? { _tag: "Complete", exit: serializeExit(value.exit) }
            : { _tag: value._tag }
      })
    }
    case "/workflow/door-open": {
      const executionId = yield* DoorWorkflow.executionId({ id })
      const token = DurableDeferred.tokenFromExecutionId(Door, { workflow: DoorWorkflow, executionId })
      yield* DurableDeferred.succeed(Door, { token, value: params.get("value") ?? "opened" })
      return { completed: true }
    }
    case "/workflow/interrupt": {
      const entry = workflows[params.get("name") as keyof typeof workflows]
      const executionId = yield* entry.workflow.executionId(entry.payload(params) as any)
      yield* entry.workflow.interrupt(executionId)
      return { interrupted: true }
    }

    default:
      return yield* Effect.fail(`unknown path: ${url.pathname}`)
  }
})

export default {
  async fetch(
    request: Request,
    env: Record<string, any>,
    ctx: { waitUntil: (promise: Promise<unknown>) => void }
  ): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/initialization/block") {
      blockInitialization()
      return Response.json({ blocked: true })
    }
    if (url.pathname === "/initialization/fail") {
      initializationFailure = true
      return Response.json({ failing: true })
    }
    if (url.pathname === "/initialization/recover") {
      initializationFailure = false
      return Response.json({ failing: false })
    }
    if (url.pathname === "/initialization/state") {
      return Response.json({
        started: initializationStarted,
        elapsedMillis: initializationStartedAt === undefined ? 0 : Date.now() - initializationStartedAt,
        completed: initializationCompleted,
        callsStarted: Array.from(initializationCallsStarted).sort(),
        callsCompleted: Array.from(initializationCallsCompleted).sort()
      })
    }
    if (url.pathname === "/initialization/open") {
      gateFor("singleton").openUnsafe()
      initializationOpen = true
      return Response.json({ opened: true })
    }
    if (url.pathname === "/initialization/call") {
      const kind = url.searchParams.get("kind") ?? "entity"
      initializationCallsStarted.add(kind)
      try {
        await callColdDurableObject(kind, env)
        initializationCallsCompleted.add(kind)
        return Response.json({ ok: true })
      } catch (error) {
        initializationCallsCompleted.add(kind)
        return Response.json({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (url.pathname === "/singleton/wake") {
      // Mirrors a Cron Trigger `scheduled` handler: fire the wake without
      // blocking the request, so gated singleton runs can be observed.
      ctx.waitUntil(env.CLUSTER_SINGLETON.getByName("Singleton/integration-singleton").wake())
      return Response.json({ woken: true })
    }
    if (url.pathname === "/cron/wake") {
      await env.CLUSTER_SINGLETON.getByName("Singleton/ClusterCron/integration-cron").wake()
      return Response.json({ woken: true })
    }
    try {
      return Response.json(await run(handle(url), env))
    } catch (error) {
      return new Response(
        error instanceof Error ? `${error.stack}\n${String((error as any).cause ?? "")}` : String(error),
        { status: 599 }
      )
    }
  }
}
