/**
 * The Durable Object classes behind `CloudflareCluster.layer`.
 *
 * A Worker using the Cloudflare cluster re-exports these four classes from its
 * entry module and binds each one in `wrangler.jsonc` as a SQLite-backed
 * Durable Object class. The cluster resolves objects through the same-Worker
 * namespace bindings only; none of these classes serve a public route, and any
 * direct `fetch` of an object is rejected.
 *
 * @stability experimental
 * @since 4.1.3
 */
import { DurableObject } from "cloudflare:workers"
import * as Effect from "effect/Effect"
import {
  type ClusterDurableQueueProgram,
  type ClusterEntityProgram,
  type ClusterSingletonProgram,
  type ClusterWorkflowProgram,
  type ClusterWorkflowRunOptions,
  type ClusterWorkflowWakeMode,
  type DurableQueueItem,
  type EntityDeliveryOptions,
  type EntityInvokeResult,
  makeClusterDurableQueueProgram,
  makeClusterEntityProgram,
  makeClusterSingletonProgram,
  makeClusterWorkflowProgram,
  type SingletonWakeResult
} from "./CloudflareDurableObjectPrograms.ts"

const notExposed = (className: string) => () => {
  throw new Error(
    `@effect/platform-cloudflare: ${className} is not exposed over fetch, use the same-Worker namespace binding`
  )
}

/**
 * Initializes the Worker application before a Cloudflare cluster Durable
 * Object handles requests or alarms. The initializer is shared by all four
 * Durable Object classes and runs once per Worker isolate unless a build fails
 * or stalls.
 *
 * **Details**
 *
 * The initializer runs inside a Durable Object constructor's
 * `blockConcurrencyWhile`, which Cloudflare cancels after 30 seconds. It must
 * complete within 15 seconds: a build still pending after that is treated as
 * abandoned, and a waiting object runs the initializer again.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type Initializer<Env = unknown, A = unknown> = (env: Env) => PromiseLike<A>

interface InitializationAttempt {
  readonly startedAt: number
  exit: {
    readonly _tag: "Success"
    readonly value: unknown
  } | {
    readonly _tag: "Failure"
    readonly error: unknown
  } | undefined
}

// Durable Object waiters run inside `blockConcurrencyWhile`, which Cloudflare
// cancels after 30 seconds. A build still pending after 15 seconds is treated
// as abandoned. Only a Durable Object waiter that has itself waited less than
// 15 seconds starts a build, whether it takes over a stale one or retries after
// a failure. The first build and any replacement therefore both get at least
// 15 seconds.
const staleInitializationMillis = 15_000
const durableObjectTakeoverMillis = 15_000
const initializationPollMillis = 20

let initializer: Initializer | undefined
let initialization: InitializationAttempt | undefined

/**
 * Registers the Worker application initializer used by the Cloudflare cluster
 * Durable Object classes.
 *
 * **Details**
 *
 * Call this once from the Worker entry module with the same lazy application
 * build used by its request handlers. Every entity, workflow, queue, and
 * singleton object blocks requests and alarms until that build completes. A
 * failure is reported to every caller already waiting on that build, and the
 * next cold caller runs the initializer again. The initializer must complete
 * within 15 seconds. A build still pending after that is treated as abandoned,
 * and a waiter runs the initializer itself, so a build can run more than once
 * in an isolate. A Durable Object waiter starts a build only while it has
 * waited less than 15 seconds, so any replacement keeps at least 15 seconds of
 * the 30 second `blockConcurrencyWhile` limit. The returned function joins the
 * same readiness state from Worker handlers.
 *
 * @stability experimental
 * @category initialization
 * @since 4.1.3
 */
export const setInitializer = <Env, A>(handler: Initializer<Env, A>): (env: Env) => Promise<A> => {
  if (initializer !== undefined) {
    throw new Error("@effect/platform-cloudflare: the Durable Object initializer is already set")
  }
  initializer = handler as Initializer
  // Worker handlers are not bounded by `blockConcurrencyWhile`, so they may
  // take over a stale build however long they have waited.
  return (env) => waitForInitialization(env, Infinity) as Promise<A>
}

const waitForInitialization = async (env: unknown, takeoverMillis: number): Promise<unknown> => {
  if (initializer === undefined) return
  const waitStartedAt = Date.now()
  const isFresh = (): boolean => Date.now() - waitStartedAt < takeoverMillis
  const canTakeOver = (attempt: InitializationAttempt): boolean => isStale(attempt) && isFresh()
  // A waiter too old to take over keeps following the current attempt.
  const keepsWaiting = (attempt: InitializationAttempt): boolean =>
    attempt.exit === undefined && initialization === attempt && !canTakeOver(attempt)
  while (true) {
    const attempt = initialization
    if (attempt === undefined ? isFresh() : canTakeOver(attempt)) {
      return runInitializer(initializer, env)
    }
    if (attempt === undefined) {
      // The attempt this waiter followed was replaced by one that already
      // failed. A waiter this old leaves the retry to a fresher caller and
      // follows the attempt that caller starts.
      await scheduler.wait(initializationPollMillis)
      continue
    }
    // Cloudflare promises belong to the request context that created them. A
    // fresh wait in this context observes the shared plain-JavaScript state
    // without awaiting the first Durable Object's promise from another event.
    while (keepsWaiting(attempt)) {
      await scheduler.wait(initializationPollMillis)
    }
    if (attempt.exit === undefined) continue
    if (attempt.exit._tag === "Failure") throw attempt.exit.error
    return attempt.exit.value
  }
}

const isStale = (attempt: InitializationAttempt): boolean =>
  attempt.exit === undefined && Date.now() - attempt.startedAt >= staleInitializationMillis

const runInitializer = async (run: Initializer, env: unknown): Promise<unknown> => {
  const attempt: InitializationAttempt = { startedAt: Date.now(), exit: undefined }
  initialization = attempt
  try {
    const value = await run(env)
    attempt.exit = { _tag: "Success", value }
    // An abandoned build that settles late still makes the isolate ready.
    if (initialization?.exit?._tag !== "Success") initialization = attempt
    return value
  } catch (error) {
    attempt.exit = { _tag: "Failure", error }
    // Waiters holding this attempt see the failure; the next cold caller retries.
    if (initialization === attempt) initialization = undefined
    throw error
  }
}

const blockOnInitialization = (
  ctx: DurableObjectState,
  env: unknown,
  after?: (() => Promise<unknown>) | undefined
): void => {
  void ctx.blockConcurrencyWhile(async () => {
    await waitForInitialization(env, durableObjectTakeoverMillis)
    if (after !== undefined) await after()
  })
}

/**
 * The shared entity class. One instance holds one entity address; the handlers
 * for every `EntityType` are registered at Worker init.
 *
 * **Details**
 *
 * The constructor stays cheap: it opens SQLite, ensures the mailbox tables,
 * and re-arms the single alarm from the earliest pending `deliver_at`, or the
 * keep-alive heartbeat when the entity holds `Entity.keepAlive`. User
 * handlers are never built in the constructor; requests and alarms wait for
 * the registered {@link setInitializer} callback, then handlers are built once
 * per wake. Each build gets a `DurableObjectSqlClient` on this object's SQLite
 * storage; tables whose names start with `cluster_` are reserved for the mailbox.
 *
 * @stability experimental
 * @category durable objects
 * @since 4.1.3
 */
export class ClusterEntity extends DurableObject<unknown> {
  // blockConcurrencyWhile completes this assignment before any RPC or alarm.
  #program!: ClusterEntityProgram

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    blockOnInitialization(ctx, env, async () => {
      this.#program = await Effect.runPromise(makeClusterEntityProgram(ctx))
    })
  }

  override alarm(): Promise<void> {
    return Effect.runPromise(this.#program.alarm())
  }

  /** @internal Keeps this object non-hibernateable while entity resources have holders. */
  hold(): Promise<void> {
    return Effect.runPromise(this.#program.hold())
  }

  /** @internal Same-Worker RPC transport used by `CloudflareCluster.layer`. */
  invoke(envelopeText: string, discard: boolean, delivery?: EntityDeliveryOptions): Promise<EntityInvokeResult> {
    return Effect.runPromise(this.#program.invoke(envelopeText, discard, delivery))
  }

  /** @internal Acknowledges a streamed chunk. */
  acknowledge(requestId: string, replyId: string): Promise<ReadonlyArray<string>> {
    return Effect.runPromise(this.#program.acknowledge(requestId, replyId))
  }

  /** @internal Interrupts a handler execution and completes its persisted ask, if any. */
  interrupt(storageRequestId: string, clientRequestId = storageRequestId): Promise<void> {
    return Effect.runPromise(this.#program.interrupt(storageRequestId, clientRequestId))
  }

  /** @internal Clears stored replies so a reset request replays from scratch. */
  reset(requestId: string): Promise<void> {
    return Effect.runPromise(this.#program.reset(requestId))
  }

  /** @internal Completes an in-memory delayed ask owned by this entity object. */
  deliverReply(requestId: string, reply: string): Promise<boolean> {
    return Effect.runPromise(this.#program.deliverReply(requestId, reply))
  }

  override fetch: () => never = notExposed("ClusterEntity")
}

/**
 * The workflow execution class behind `CloudflareWorkflowEngine`. One
 * instance holds one workflow execution: run state, activity results keyed
 * `${name}/${attempt}`, durable deferred exits, and the clock due table.
 *
 * **Details**
 *
 * The constructor stays cheap: it opens SQLite, ensures the workflow tables,
 * and re-arms the single alarm from the earliest pending clock. Workflow
 * requests and alarms wait for the registered {@link setInitializer} callback
 * before handlers are looked up in the module-level registry and built once
 * per wake.
 *
 * @stability experimental
 * @category durable objects
 * @since 4.1.3
 */
export class ClusterWorkflow extends DurableObject<unknown> {
  // blockConcurrencyWhile completes this assignment before any RPC or alarm.
  #program!: ClusterWorkflowProgram

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    blockOnInitialization(ctx, env, async () => {
      this.#program = await Effect.runPromise(makeClusterWorkflowProgram(ctx))
    })
  }

  /** @internal Same-Worker RPC transport used by `CloudflareWorkflowEngine`. */
  run(payload: string, options: ClusterWorkflowRunOptions): Promise<string> {
    return Effect.runPromise(this.#program.run(payload, options))
  }

  /** @internal */
  poll(): Promise<string | undefined> {
    return Effect.runPromise(this.#program.poll())
  }

  /** @internal */
  resume(mode?: ClusterWorkflowWakeMode): Promise<void> {
    return Effect.runPromise(this.#program.resume(mode))
  }

  /** @internal */
  interrupt(): Promise<void> {
    return Effect.runPromise(this.#program.interrupt())
  }

  /** @internal */
  interruptUnsafe(): Promise<void> {
    return Effect.runPromise(this.#program.interruptUnsafe())
  }

  /** @internal Records a durable deferred exit and resumes the execution. */
  deferredDone(name: string, exit: string): Promise<void> {
    return Effect.runPromise(this.#program.deferredDone(name, exit))
  }

  /** @internal Persists a durable clock and arms the single alarm. */
  scheduleClock(name: string, deferredName: string, wakeUp: number): Promise<void> {
    return Effect.runPromise(this.#program.scheduleClock(name, deferredName, wakeUp))
  }

  override alarm(): Promise<void> {
    return Effect.runPromise(this.#program.alarm())
  }

  override fetch: () => never = notExposed("ClusterWorkflow")
}

/**
 * The durable queue class behind the `PersistedQueue` implementation used by
 * `DurableQueue`. One instance holds one named queue.
 *
 * **Details**
 *
 * The constructor stays cheap: it opens SQLite, ensures the queue table, and
 * re-arms the single alarm from the earliest pending lease expiry. Items are
 * leased to takers for a bounded time; the alarm watchdog expires overdue
 * leases so an item whose worker died is redelivered. Requests and alarms wait
 * for the registered {@link setInitializer} callback first.
 *
 * @stability experimental
 * @category durable objects
 * @since 4.1.3
 */
export class ClusterDurableQueue extends DurableObject<unknown> {
  // blockConcurrencyWhile completes this assignment before any RPC or alarm.
  #program!: ClusterDurableQueueProgram

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    blockOnInitialization(ctx, env, async () => {
      this.#program = await Effect.runPromise(makeClusterDurableQueueProgram(ctx))
    })
  }

  /** @internal Same-Worker RPC transport used by `CloudflarePersistedQueue.layer`. */
  offer(
    id: string,
    element: string,
    delayMillis?: number,
    deduplicate?: "untilExecuted" | "untilRemoved"
  ): Promise<void> {
    return Effect.runPromise(this.#program.offer(id, element, delayMillis, deduplicate))
  }

  /** @internal Waits until an item is available, then leases it to the caller. */
  take(takerId: string, maxAttempts: number, leaseMillis: number): Promise<DurableQueueItem> {
    return Effect.runPromise(this.#program.take(takerId, maxAttempts, leaseMillis))
  }

  /** @internal Cancels a waiting take, releasing an item already leased to it. */
  cancelTake(takerId: string): Promise<void> {
    return Effect.runPromise(this.#program.cancelTake(takerId))
  }

  /** @internal Completes the item while the taker still owns its lease. */
  complete(id: string, takerId: string): Promise<void> {
    return Effect.runPromise(this.#program.complete(id, takerId))
  }

  /**
   * @internal Records a failed attempt and requeues the item, or marks it failed
   * after its final attempt or a terminal failure. A requeued item stays hidden
   * for `retryDelayMillis`.
   */
  fail(id: string, lastFailure: string, takerId: string, terminal?: boolean, retryDelayMillis?: number): Promise<void> {
    return Effect.runPromise(this.#program.fail(id, lastFailure, takerId, terminal, retryDelayMillis))
  }

  /** @internal Requeues the item and refunds the attempt its lease counted. */
  release(id: string, takerId: string): Promise<void> {
    return Effect.runPromise(this.#program.release(id, takerId))
  }

  /** @internal Extends the lease of an item still being processed. */
  extend(id: string, leaseMillis: number, takerId: string): Promise<void> {
    return Effect.runPromise(this.#program.extend(id, leaseMillis, takerId))
  }

  override alarm(): Promise<void> {
    return Effect.runPromise(this.#program.alarm())
  }

  override fetch: () => never = notExposed("ClusterDurableQueue")
}

/**
 * The singleton class. One object holds one registered singleton under the
 * name `Singleton/<name>` and is woken by a Worker Cron Trigger.
 *
 * **Details**
 *
 * The constructor opens SQLite, ensures the singleton state table, and
 * re-arms the watchdog alarm for a wake interrupted by isolate loss. `wake()`
 * runs the registered effect once and returns; it never appends
 * `Effect.never`, so Cloudflare may hibernate the object afterward. A failed
 * run is logged and resolves `wake()` with a `Failure`, so only a transport
 * failure rejects it. Requests
 * and alarms wait for the registered {@link setInitializer} callback before
 * consulting the singleton registry.
 *
 * @stability experimental
 * @category durable objects
 * @since 4.1.3
 */
export class ClusterSingleton extends DurableObject<unknown> {
  // blockConcurrencyWhile completes this assignment before any RPC or alarm.
  #program!: ClusterSingletonProgram

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    blockOnInitialization(ctx, env, async () => {
      this.#program = await Effect.runPromise(makeClusterSingletonProgram(ctx))
    })
  }

  /** @internal Runs one Cron Trigger fire, coalescing a concurrent duplicate. */
  wake(): Promise<SingletonWakeResult> {
    return Effect.runPromise(this.#program.wake())
  }

  override alarm(): Promise<void> {
    return Effect.runPromise(this.#program.alarm())
  }

  override fetch: () => never = notExposed("ClusterSingleton")
}
