import * as CloudflarePersistedQueue from "@effect/platform-cloudflare/CloudflarePersistedQueue"
import { encodeName } from "@effect/platform-cloudflare/internal/clusterName"
import { armAlarm, type EntityAlarm } from "@effect/platform-cloudflare/internal/entityStorage"
import { makeQueueRuntime, type QueueRuntime } from "@effect/platform-cloudflare/internal/queueRuntime"
import { earliestLeaseExpiry } from "@effect/platform-cloudflare/internal/queueStorage"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Latch, Layer, Schedule, Schema } from "effect"
import * as PersistedQueueTest from "effect-test/persistence/PersistedQueueTest"
import { PersistedQueue } from "effect/persistence"
import { DatabaseSync } from "node:sqlite"
import { SqliteStorage } from "./fixtures/sqliteStorage.ts"

// Real SQLite, so the fixture never mirrors the queue's SQL statements.
const makeSql = (): SqliteStorage => new SqliteStorage(new DatabaseSync(":memory:"))

const leaseUntil = (sql: SqliteStorage, id: string): unknown =>
  sql.sql.exec("SELECT lease_until FROM queue_items WHERE id = ?", id).toArray()[0]?.lease_until

class FakeAlarm {
  current: number | null = null

  constructor(readonly onSchedule?: (scheduledTime: number) => void) {}

  getAlarm() {
    return Promise.resolve(this.current)
  }
  setAlarm(scheduledTime: number) {
    this.current = scheduledTime
    this.onSchedule?.(scheduledTime)
    return Promise.resolve()
  }

  get alarm(): EntityAlarm {
    return this as unknown as EntityAlarm
  }
}

class FakeQueueNamespace {
  readonly stores = new Map<string, { readonly sql: SqliteStorage; readonly alarm: FakeAlarm }>()
  readonly runtimes = new Map<string, QueueRuntime>()
  now = 0

  constructor(
    readonly clockNow?: () => number,
    readonly onSchedule?: (name: string, scheduledTime: number) => void
  ) {}

  store(name: string) {
    let store = this.stores.get(name)
    if (store === undefined) {
      store = { sql: makeSql(), alarm: new FakeAlarm((time) => this.onSchedule?.(name, time)) }
      this.stores.set(name, store)
    }
    return store
  }

  getByName(name: string): QueueRuntime {
    let runtime = this.runtimes.get(name)
    if (runtime === undefined) {
      const store = this.store(name)
      // Mirrors the ClusterDurableQueue constructor: build the runtime and
      // re-arm the single alarm from the earliest pending lease expiry.
      runtime = makeQueueRuntime({
        sql: store.sql.sql,
        alarm: store.alarm.alarm,
        now: () => this.clockNow?.() ?? this.now
      })
      const expiry = earliestLeaseExpiry(store.sql.sql)
      if (expiry !== undefined) {
        void Effect.runPromise(armAlarm(store.alarm.alarm, expiry))
      }
      this.runtimes.set(name, runtime)
    }
    return runtime
  }

  /** Drops every in-memory runtime, as a crashed or hibernated isolate would. */
  crash() {
    this.runtimes.clear()
  }

  fireDueAlarms(): Promise<void> {
    const fired: Array<Promise<void>> = []
    for (const [name, store] of this.stores) {
      if (store.alarm.current !== null && store.alarm.current <= (this.clockNow?.() ?? this.now)) {
        store.alarm.current = null
        fired.push(this.getByName(name).runAlarm())
      }
    }
    return Promise.all(fired).then(() => undefined)
  }

  get layer() {
    return CloudflarePersistedQueue.layer({ queueNamespace: this as never })
  }
}

const settle = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))

const objectName = (queueName: string) => encodeName("PersistedQueue", queueName)

// Takes without waiting: undefined when no item is available now. An available
// item is leased and resolved in microtasks, which all run before the timer
// fires however late it is, so the timer only decides the empty case.
const takeNow = (runtime: QueueRuntime, takerId: string, maxAttempts = 10) =>
  Effect.promise(async () => {
    const item = await Promise.race([
      runtime.take(takerId, maxAttempts, 500),
      new Promise<undefined>((resolve) => setTimeout(resolve, 1))
    ])
    if (item === undefined) await runtime.cancelTake(takerId)
    return item
  })

// "stale" leases "a" and stalls past its lease, then "live" leases and
// completes it. "stale" still believes it holds the item.
const completedBehindStaleLease = Effect.fnUntraced(function*(namespace: FakeQueueNamespace, name: string) {
  const runtime = namespace.getByName(name)
  yield* Effect.promise(() => runtime.offer("a", "\"first\""))
  yield* Effect.promise(() => runtime.take("stale", 10, 500))
  namespace.now = 600
  yield* Effect.promise(() => namespace.fireDueAlarms())
  const live = yield* Effect.promise(() => runtime.take("live", 10, 500))
  assert.strictEqual(live.id, "a")
  yield* Effect.promise(() => runtime.complete("a", "live"))
  return runtime
})

describe("CloudflarePersistedQueue", () => {
  it.effect("keeps completed items so a re-offered id stays deduplicated", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({ name: "orders", schema: Schema.String })
      yield* queue.offer("first", { id: "a" })
      yield* queue.take(() => Effect.void)
      yield* queue.offer("again", { id: "a" })
      yield* queue.offer("next", { id: "b" })
      assert.strictEqual(yield* queue.take((value) => Effect.succeed(value)), "next")
    }).pipe(Effect.provide(namespace.layer))
  })

  it.effect("cancelling a waiting take keeps the next offer for live takers", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({ name: "cancelled", schema: Schema.String })
      const fiber = yield* Effect.forkChild(queue.take((value) => Effect.succeed(value)))
      yield* settle()
      yield* Fiber.interrupt(fiber)
      yield* queue.offer("job", { id: "a" })
      // The interrupted taker's waiter is gone; the item is immediately
      // available instead of leased to a dead taker for the lease period.
      assert.strictEqual(yield* queue.take((value) => Effect.succeed(value)), "job")
    }).pipe(Effect.provide(namespace.layer))
  })

  it.effect("cancelling a taker that was already leased an item releases it", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = namespace.getByName(objectName("raced"))
      const pending = runtime.take("taker-1", 10, 500)
      yield* settle()
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => pending)
      const store = namespace.stores.get(objectName("raced"))!
      assert.isNotNull(leaseUntil(store.sql, "a"))
      // The taker's fiber was interrupted after the item was leased but
      // before it could register its finalizer; the cancel releases it.
      yield* Effect.promise(() => runtime.cancelTake("taker-1"))
      assert.isNull(leaseUntil(store.sql, "a"))
      const replay = yield* Effect.promise(() => runtime.take("taker-2", 10, 500))
      assert.strictEqual(replay.id, "a")
    })
  })

  it.effect("a cancel after a restart releases the item leased to its taker", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("restarted-cancel")
    return Effect.gen(function*() {
      yield* Effect.promise(() => namespace.getByName(name).offer("a", "\"first\""))
      yield* Effect.promise(() => namespace.getByName(name).take("taker", 1, 500))
      namespace.crash()
      const runtime = namespace.getByName(name)
      yield* Effect.promise(() => runtime.cancelTake("taker"))
      // The cancel refunded the only attempt, so another taker gets the item now.
      assert.strictEqual((yield* takeNow(runtime, "next", 1))?.id, "a")
    })
  })

  it.effect("a cancel does not refund an expired earlier lease of its taker", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = namespace.getByName(objectName("expired-cancel"))
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.take("taker", 1, 500))
      yield* Effect.promise(() => runtime.offer("b", "\"second\""))
      // The lease on "a" expires before its alarm runs; the retried take gets "b".
      namespace.now = 600
      assert.strictEqual((yield* Effect.promise(() => runtime.take("taker", 1, 500))).id, "b")
      yield* Effect.promise(() => runtime.cancelTake("taker"))
      // "a" spent its only attempt, so only "b" is available again.
      assert.strictEqual((yield* takeNow(runtime, "next", 1))?.id, "b")
    })
  })

  it.effect("an interrupted last attempt can be taken again", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({ name: "refund", schema: Schema.String, maxAttempts: 1 })
      yield* queue.offer("job", { id: "a" })
      const latch = Latch.makeUnsafe()
      const fiber = yield* Effect.forkChild(queue.take(() => Effect.andThen(latch.open, Effect.never)))
      yield* latch.await
      yield* Fiber.interrupt(fiber)
      // The interrupt refunded the claim, so the only attempt is still unused.
      const item = yield* takeNow(namespace.getByName(objectName("refund")), "next", 1)
      assert.strictEqual(item?.id, "a")
    }).pipe(Effect.provide(namespace.layer))
  })

  // A broken take RPC is retried by the Worker with the same taker id.
  it.effect("a retried take replaces the waiting take of its taker", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = namespace.getByName(objectName("retried-wait"))
      void runtime.take("taker", 10, 500)
      const retried = runtime.take("taker", 10, 500)
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.offer("b", "\"second\""))
      assert.strictEqual((yield* Effect.promise(() => retried)).id, "a")
      // No stale waiter leased "b" to a taker that will never handle it.
      assert.strictEqual((yield* takeNow(runtime, "other"))?.id, "b")
    })
  })

  it.effect("a retried take returns the item already leased to its taker", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = namespace.getByName(objectName("retried-lease"))
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.offer("b", "\"second\""))
      const first = yield* Effect.promise(() => runtime.take("taker", 10, 500))
      const retried = yield* Effect.promise(() => runtime.take("taker", 10, 500))
      assert.deepStrictEqual({ ...retried }, { ...first })
    })
  })

  it.effect("a take retried after a restart returns the item already leased to its taker", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("restarted-lease")
    return Effect.gen(function*() {
      const runtime = namespace.getByName(name)
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      const first = yield* Effect.promise(() => runtime.take("taker", 10, 500))
      // The object restarted before the lease reached the Worker.
      namespace.crash()
      const retried = yield* takeNow(namespace.getByName(name), "taker")
      assert.deepStrictEqual({ ...retried }, { ...first })
    })
  })

  it.effect("requeues a failed item behind later offers", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = namespace.getByName(objectName("ordered"))
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.offer("b", "\"second\""))
      const item = yield* Effect.promise(() => runtime.take("taker-1", 10, 500))
      assert.strictEqual(item.id, "a")
      yield* Effect.promise(() => runtime.fail(item.id, "boom", "taker-1"))
      // The retry sorts after the untouched item, so "a" cannot hot-loop.
      const next = yield* Effect.promise(() => runtime.take("taker-2", 10, 500))
      assert.strictEqual(next.id, "b")
      const retried = yield* Effect.promise(() => runtime.take("taker-3", 10, 500))
      assert.strictEqual(retried.id, "a")
    })
  })

  it.effect("a failed item waits out its retry delay on the object instead of in take", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: "backoff",
        schema: Schema.String,
        retrySchedule: Schedule.spaced("1 minute")
      })
      yield* queue.offer("bad", { id: "a" })
      yield* Effect.flip(queue.take(() => Effect.fail("boom")))
      yield* queue.offer("fresh", { id: "b" })
      // The retry stays hidden for its delay, so the fresh item is delivered now.
      const early = yield* takeNow(namespace.getByName(objectName("backoff")), "early")
      assert.strictEqual(early?.id, "b")

      namespace.now = 60_000
      yield* Effect.promise(() => namespace.fireDueAlarms())
      // The delay has passed, so take delivers the retry without waiting again.
      assert.strictEqual(yield* queue.take((value) => Effect.succeed(value)), "bad")
    }).pipe(Effect.provide(namespace.layer))
  })

  it.effect("redelivers a leased item after a crash once the lease expires", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("jobs")
    return Effect.gen(function*() {
      namespace.now = 1000
      const runtime = namespace.getByName(name)
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      const item = yield* Effect.promise(() => runtime.take("taker-1", 10, 500))
      assert.strictEqual(item.id, "a")
      const store = namespace.stores.get(name)!
      assert.strictEqual(store.alarm.current, 1500)

      // The worker died mid-processing and the object lost its alarm.
      namespace.crash()
      store.alarm.current = null
      namespace.getByName(name)
      yield* settle()
      assert.strictEqual(store.alarm.current, 1500)

      namespace.now = 2000
      yield* Effect.promise(() => namespace.fireDueAlarms())
      const replay = yield* Effect.promise(() => namespace.getByName(name).take("taker-2", 10, 500))
      assert.strictEqual(replay.id, "a")
      assert.strictEqual(replay.element, "\"first\"")
      // The crashed claim still used an attempt.
      assert.strictEqual(replay.attempts, item.attempts + 1)
    })
  })

  it.effect("a crash on the last attempt leaves the item failed", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("crash-last-attempt")
    return Effect.gen(function*() {
      const runtime = namespace.getByName(name)
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.take("taker-1", 1, 500))

      namespace.crash()
      namespace.now = 600
      yield* Effect.promise(() => namespace.fireDueAlarms())

      // A failed item releases its id, so the re-offer is the next delivery.
      const restarted = namespace.getByName(name)
      yield* Effect.promise(() => restarted.offer("a", "\"second\"", 0, "untilExecuted"))
      const item = yield* takeNow(restarted, "taker-2")
      assert.strictEqual(item?.element, "\"second\"")
    })
  })

  it.effect("a repaired untilExecuted offer replaces an element that failed to decode", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const legacy = yield* PersistedQueue.make({ name: "repaired", schema: Schema.Number })
      const queue = yield* PersistedQueue.make({ name: "repaired", schema: Schema.String })
      yield* legacy.offer(1, { id: "job" })
      yield* queue.offer("next", { id: "other" })
      // The incompatible payload is skipped.
      assert.strictEqual(yield* queue.take((value) => Effect.succeed(value)), "next")

      yield* queue.offer("fixed", { id: "job", deduplicate: "untilExecuted" })
      const item = yield* takeNow(namespace.getByName(objectName("repaired")), "taker")
      assert.strictEqual(item?.element, "\"fixed\"")
    }).pipe(Effect.provide(namespace.layer))
  })

  it.effect("arms a delayed offer without a taker and restores its deadline after a crash", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("delayed-crash")
    return Effect.gen(function*() {
      namespace.now = 1000
      yield* Effect.promise(() => namespace.getByName(name).offer("a", "\"delayed\"", 500))
      const store = namespace.stores.get(name)!
      assert.strictEqual(store.alarm.current, 1500)

      namespace.crash()
      store.alarm.current = null
      const runtime = namespace.getByName(name)
      yield* settle()
      assert.strictEqual(store.alarm.current, 1500)

      let delivered: string | undefined
      const pending = runtime.take("taker", 10, 500).then((item) => {
        delivered = item.element
        return item
      })
      namespace.now = 1499
      yield* Effect.promise(() => namespace.fireDueAlarms())
      yield* settle()
      assert.isUndefined(delivered)

      namespace.now = 1500
      yield* Effect.promise(() => namespace.fireDueAlarms())
      const item = yield* Effect.promise(() => pending)
      assert.strictEqual(item.id, "a")
      assert.strictEqual(item.element, "\"delayed\"")
      assert.strictEqual(item.attempts, 0)
    })
  })

  it.effect("an extended lease survives the original expiry", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("extended")
    return Effect.gen(function*() {
      const runtime = namespace.getByName(name)
      yield* Effect.promise(() => runtime.offer("a", "\"slow\""))
      const item = yield* Effect.promise(() => runtime.take("taker-1", 10, 500))
      const store = namespace.stores.get(name)!
      assert.strictEqual(store.alarm.current, 500)
      namespace.now = 400
      yield* Effect.promise(() => runtime.extend(item.id, 500, "taker-1"))
      assert.strictEqual(leaseUntil(store.sql, "a"), 900)

      // The stale alarm fires at the original expiry, finds the lease still
      // live, and re-arms the watchdog at the extended expiry.
      namespace.now = 500
      yield* Effect.promise(() => namespace.fireDueAlarms())
      assert.isNotNull(leaseUntil(store.sql, "a"))
      assert.strictEqual(store.alarm.current, 900)

      namespace.now = 1000
      yield* Effect.promise(() => namespace.fireDueAlarms())
      const replay = yield* Effect.promise(() => runtime.take("taker-2", 10, 500))
      assert.strictEqual(replay.id, "a")
    })
  })

  it.effect("an expired lease cannot complete a re-offered element", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = yield* completedBehindStaleLease(namespace, objectName("stale-complete"))
      yield* Effect.promise(() => runtime.offer("a", "\"second\"", 0, "untilExecuted"))
      yield* Effect.promise(() => runtime.complete("a", "stale"))
      const item = yield* takeNow(runtime, "next")
      assert.strictEqual(item?.element, "\"second\"")
    })
  })

  it.effect("an expired lease cannot move the deadline of a delayed re-offer", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("stale-deadline")
    return Effect.gen(function*() {
      const runtime = yield* completedBehindStaleLease(namespace, name)
      yield* Effect.promise(() => runtime.offer("a", "\"second\"", 1000, "untilExecuted"))
      yield* Effect.promise(() => runtime.extend("a", 5000, "stale"))
      yield* Effect.promise(() => runtime.release("a", "stale"))
      assert.isUndefined(yield* takeNow(runtime, "early"))

      namespace.now = 1600
      yield* Effect.promise(() => namespace.fireDueAlarms())
      const item = yield* takeNow(runtime, "due")
      assert.strictEqual(item?.element, "\"second\"")
    })
  })

  it.effect("an expired lease cannot reopen an element another taker completed", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = yield* completedBehindStaleLease(namespace, objectName("stale-fail"))
      yield* Effect.promise(() => runtime.fail("a", "boom", "stale"))
      assert.isUndefined(yield* takeNow(runtime, "next"))
    })
  })

  it.effect("a replayed fail counts the attempt once", () => {
    const namespace = new FakeQueueNamespace()
    return Effect.gen(function*() {
      const runtime = namespace.getByName(objectName("replayed-fail"))
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.take("taker", 2, 500))
      // The finalizer retries a fail whose response was lost.
      yield* Effect.promise(() => runtime.fail("a", "boom", "taker"))
      yield* Effect.promise(() => runtime.fail("a", "boom", "taker"))
      const item = yield* takeNow(runtime, "next")
      assert.strictEqual(item?.id, "a")
    })
  })

  it.effect("wakes a waiting taker and re-arms the alarm for the next lease", () => {
    const namespace = new FakeQueueNamespace()
    const name = objectName("watchdog")
    return Effect.gen(function*() {
      namespace.now = 0
      const runtime = namespace.getByName(name)
      yield* Effect.promise(() => runtime.offer("a", "\"first\""))
      yield* Effect.promise(() => runtime.offer("b", "\"second\""))
      yield* Effect.promise(() => runtime.take("taker-1", 10, 500))
      yield* Effect.promise(() => runtime.take("taker-2", 10, 5000))
      const store = namespace.stores.get(name)!
      assert.strictEqual(store.alarm.current, 500)

      let woken: string | undefined
      const waiting = runtime.take("taker-3", 10, 500).then((item) => {
        woken = item.id
      })
      yield* settle()
      assert.isUndefined(woken)

      namespace.now = 600
      yield* Effect.promise(() => namespace.fireDueAlarms())
      yield* Effect.promise(() => waiting)
      assert.strictEqual(woken, "a")
      // Re-armed at the earliest remaining lease: the waiter's fresh lease.
      assert.strictEqual(store.alarm.current, 1100)
    })
  })
})

// The store-agnostic PersistedQueueStore contract suite the memory, Redis,
// and SQL stores also run against.
PersistedQueueTest.suite(
  "cloudflare",
  Layer.effect(PersistedQueue.PersistedQueueStore)(Effect.gen(function*() {
    const clock = yield* Clock.Clock
    const scope = yield* Effect.scope
    const runFork = Effect.runForkWith(yield* Effect.context())
    const namespace = new FakeQueueNamespace(
      () => clock.currentTimeMillisUnsafe(),
      (name, scheduledTime) => {
        // Cloudflare dispatches alarms independently of queue RPCs. Use the
        // suite clock for both the runtime timestamp and that dispatch.
        runFork(
          Effect.gen(function*() {
            yield* Effect.sleep(Math.max(0, scheduledTime - clock.currentTimeMillisUnsafe()))
            if (namespace.store(name).alarm.current === scheduledTime) {
              yield* Effect.promise(() => namespace.fireDueAlarms())
            }
          }).pipe(Effect.forkIn(scope))
        )
      }
    )
    return CloudflarePersistedQueue.make({ queueNamespace: namespace as never })
  })),
  { cleanup: "unsupported" }
)
