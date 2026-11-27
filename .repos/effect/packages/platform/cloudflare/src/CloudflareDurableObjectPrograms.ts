/**
 * Class-independent Durable Object programs behind the Cloudflare cluster
 * integration.
 *
 * The bundled classes in `CloudflareDurableObjects` bind these behaviors to
 * `cloudflare:workers` base classes for the Wrangler path. A framework that
 * creates its own Durable Object classes (for example the Alchemy integration
 * in `AlchemyCloudflareCluster`) runs these programs instead and forwards its
 * class methods to the returned handles.
 *
 * @stability experimental
 * @since 4.1.3
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as ClusterMetrics from "effect/cluster/ClusterMetrics"
import * as EntityAddress from "effect/cluster/EntityAddress"
import * as EntityId from "effect/cluster/EntityId"
import * as EntityType from "effect/cluster/EntityType"
import * as ShardId from "effect/cluster/ShardId"
import * as Effect from "effect/Effect"
import { decodeName, encodeName } from "./internal/clusterName.ts"
import { makeEntityKeepAlive } from "./internal/entityKeepAlive.ts"
import { keepAliveHeartbeatMillis } from "./internal/entityRegistry.ts"
import { makeEntityManager } from "./internal/entityRuntime.ts"
import {
  armAlarm,
  earliestDeliverAt,
  ensureEntityStorage,
  loadEntityState,
  rememberEntityName
} from "./internal/entityStorage.ts"
import { makeQueueRuntime } from "./internal/queueRuntime.ts"
import { earliestLeaseExpiry } from "./internal/queueStorage.ts"
import { getSingletonRegistration } from "./internal/singletonRegistry.ts"
import { makeSingletonRuntime } from "./internal/singletonRuntime.ts"
import { ensureSingletonStorage, loadSingletonState, rememberSingletonName } from "./internal/singletonStorage.ts"
import type { WorkflowStub } from "./internal/workflowRegistry.ts"
import { makeWorkflowRuntime } from "./internal/workflowRuntime.ts"
import { earliestClockWakeUp, ensureWorkflowStorage, loadExecution } from "./internal/workflowStorage.ts"

/**
 * The native Durable Object capabilities a cluster program is built from.
 *
 * **Details**
 *
 * A `DurableObjectState` from `cloudflare:workers` satisfies this shape
 * directly, so pass it as is. The program only reads the object name, opens
 * SQLite storage, resolves same-Worker class exports, and extends the current
 * event with `waitUntil`.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export interface DurableObjectProgramState {
  readonly id: { readonly name?: string | undefined }
  readonly storage: DurableObjectStorage
  readonly exports: object
  readonly waitUntil: (promise: Promise<unknown>) => void
}

const exportedNamespace = <Stub>(
  state: DurableObjectProgramState,
  className: string
): { readonly getByName: (name: string) => Stub } | undefined =>
  (state.exports as Record<string, unknown>)[className] as
    | { readonly getByName: (name: string) => Stub }
    | undefined

/**
 * Delivery options accepted by the cluster entity transport program.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export interface EntityDeliveryOptions {
  readonly deliverAt?: number | undefined
  readonly primaryKey?: string | null | undefined
  readonly replyTo?: string | undefined
}

/**
 * Result returned by the cluster entity transport program.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type EntityInvokeResult = {
  readonly _tag: "Success"
  readonly requestId: string
  readonly replies: ReadonlyArray<string>
} | {
  readonly _tag: "MailboxFull"
} | {
  readonly _tag: "EncodedMessageTooLarge"
} | {
  readonly _tag: "AskDeduplicatedToTell"
}

/**
 * Effect-valued program for one cluster entity Durable Object instance.
 *
 * **Gotchas**
 *
 * All program methods must keep their error channel `never`: Alchemy encodes
 * typed failures as envelopes, but the native namespace transport expects
 * plain results and rejected defects.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type ClusterEntityProgram = {
  readonly alarm: () => Effect.Effect<void>
  readonly hold: () => Effect.Effect<void>
  readonly invoke: (
    envelopeText: string,
    discard: boolean,
    delivery?: EntityDeliveryOptions
  ) => Effect.Effect<EntityInvokeResult>
  readonly acknowledge: (requestId: string, replyId: string) => Effect.Effect<ReadonlyArray<string>>
  readonly interrupt: (storageRequestId: string, clientRequestId?: string) => Effect.Effect<void>
  readonly reset: (requestId: string) => Effect.Effect<void>
  readonly deliverReply: (requestId: string, reply: string) => Effect.Effect<boolean>
}

/**
 * Creates the program behind one cluster entity Durable Object.
 *
 * **When to use**
 *
 * Use when a framework creates the native Durable Object class itself and
 * needs the entity mailbox, alarm, and same-Worker RPC behavior without
 * extending the bundled `ClusterEntity` class.
 *
 * **Details**
 *
 * Run the returned Effect once per Durable Object activation, after the
 * Worker application (the entity handler registrations) is initialized. It
 * ensures the mailbox tables and re-arms the single alarm from the earliest
 * pending `deliver_at`, or the keep-alive heartbeat when that alarm is
 * missing, before returning the handler object. The host class must be
 * exported from the Worker entry as `ClusterEntity`; keep-alive and reply
 * delivery resolve that export through `state.exports`.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.3
 */
export const makeClusterEntityProgram = Effect.fnUntraced(function*(state: DurableObjectProgramState) {
  const sql = state.storage.sql
  ensureEntityStorage(sql)
  const stored = loadEntityState(sql)
  // An alarm wake may carry no `id.name`; fall back to the name stored by an
  // earlier activation, so heartbeat and `deliverAt` alarms still run.
  const entityName = state.id.name ?? stored.name ?? ""
  const name = decodeName(entityName)
  if (name === undefined) {
    return yield* Effect.die(new Error("ClusterEntity requires a canonical entity Durable Object name"))
  }
  // Written only when it changes, so a repeat activation costs no write.
  if (entityName !== stored.name) rememberEntityName(sql, entityName)
  const keepAlive = makeEntityKeepAlive({
    startHold: () => {
      const namespace = exportedNamespace<{ readonly hold: () => Promise<void> }>(state, "ClusterEntity")
      if (namespace === undefined) {
        return Promise.reject(
          new Error("CloudflareCluster: ClusterEntity export is unavailable for keep-alive")
        )
      }
      return namespace.getByName(entityName).hold()
    },
    wanted: stored.keepAlive,
    persist: (wanted) => manager.saveKeepAlive(wanted),
    retryCapMillis: () => keepAliveHeartbeatMillis(name.type)
  })
  const manager = makeEntityManager({
    storage: state.storage,
    address: EntityAddress.make({
      shardId: ShardId.make("default", 1),
      entityType: EntityType.make(name.type),
      entityId: EntityId.make(name.id)
    }),
    entityName,
    keepAlive,
    waitUntil: (effect) => state.waitUntil(Effect.runPromise(effect)),
    getNamespace: () =>
      exportedNamespace<{
        readonly deliverReply: (requestId: string, reply: string) => Promise<boolean>
      }>(state, "ClusterEntity")
  })
  // A stored keep-alive flag arms the heartbeat too. That repairs the chain
  // after Cloudflare dropped an alarm whose retries all failed, or after a
  // crash between the flag write and `setAlarm`. Arming at `now` on every
  // activation would fire one wasted alarm per wake.
  const deliverAt = earliestDeliverAt(sql)
  const alarmAt = stored.keepAlive
    ? Math.min(deliverAt ?? Infinity, Date.now() + keepAliveHeartbeatMillis(name.type))
    : deliverAt
  if (alarmAt !== undefined) {
    yield* armAlarm(state.storage, alarmAt)
  }
  const program: ClusterEntityProgram = {
    alarm: () => manager.alarm,
    hold: () => keepAlive.await,
    invoke: (envelopeText, discard, delivery) => manager.invoke(envelopeText, discard, delivery),
    acknowledge: manager.acknowledge,
    interrupt: manager.interrupt,
    reset: manager.reset,
    deliverReply: manager.deliverReply
  }
  return program
})

/**
 * Execution options accepted by the workflow program's `run`.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export interface ClusterWorkflowRunOptions {
  readonly discard: boolean
  readonly parent?: { readonly workflowName: string; readonly executionId: string } | undefined
}

/**
 * How a workflow resume was requested. `"explicit"` (the default) always
 * replays the execution; `"automatic"`, used for a child's completion wake,
 * leaves an execution suspended by `Workflow.SuspendOnFailure` parked until
 * an explicit resume.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type ClusterWorkflowWakeMode = "explicit" | "automatic"

/**
 * Effect-valued program for one workflow execution Durable Object.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type ClusterWorkflowProgram = {
  readonly run: (payload: string, options: ClusterWorkflowRunOptions) => Effect.Effect<string>
  readonly poll: () => Effect.Effect<string | undefined>
  readonly resume: (mode?: ClusterWorkflowWakeMode) => Effect.Effect<void>
  readonly interrupt: () => Effect.Effect<void>
  readonly interruptUnsafe: () => Effect.Effect<void>
  readonly deferredDone: (name: string, exit: string) => Effect.Effect<void>
  readonly scheduleClock: (name: string, deferredName: string, wakeUp: number) => Effect.Effect<void>
  readonly alarm: () => Effect.Effect<void>
}

/**
 * Creates the program behind one workflow execution Durable Object.
 *
 * **When to use**
 *
 * Use when a framework creates the native Durable Object class itself and
 * needs the Effect Workflow journal, alarm, and same-Worker RPC behavior
 * without extending the bundled `ClusterWorkflow` class.
 *
 * **Details**
 *
 * Run the returned Effect once per Durable Object activation, after the
 * Worker application (the workflow handler registrations) is initialized. It
 * ensures the workflow tables and re-arms the single alarm from the earliest
 * pending clock before returning the handler object. The host class must be
 * exported from the Worker entry as `ClusterWorkflow`; child and parent
 * workflow delivery resolves that export through `state.exports`.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.3
 */
export const makeClusterWorkflowProgram = Effect.fnUntraced(function*(state: DurableObjectProgramState) {
  const clock = yield* Clock.Clock
  const sql = state.storage.sql
  ensureWorkflowStorage(sql)
  let name: string | undefined
  if (state.id.name !== undefined) {
    if (decodeName(state.id.name) === undefined) {
      return yield* Effect.die(new Error("ClusterWorkflow requires a canonical workflow Durable Object name"))
    }
    name = state.id.name
  } else {
    // An alarm wake carries no `id.name`; recover it from the stored
    // execution so due clocks still fire after eviction.
    const stored = loadExecution(sql)
    name = stored === undefined ? undefined : encodeName(stored.workflowName, stored.executionId)
  }
  let runtime: ReturnType<typeof makeWorkflowRuntime> | undefined
  const getRuntime = () => {
    if (runtime !== undefined) return runtime
    if (name === undefined) {
      throw new Error("ClusterWorkflow requires a canonical workflow Durable Object name")
    }
    runtime = makeWorkflowRuntime({
      name,
      sql,
      alarm: state.storage,
      now: () => clock.currentTimeMillisUnsafe(),
      waitUntil: (promise) => state.waitUntil(promise),
      getStub: (stubName) => {
        const namespace = exportedNamespace<WorkflowStub>(state, "ClusterWorkflow")
        if (namespace === undefined) {
          throw new Error("CloudflareCluster: ClusterWorkflow export is unavailable for workflow delivery")
        }
        return namespace.getByName(stubName)
      }
    })
    return runtime
  }
  const wakeUp = earliestClockWakeUp(sql)
  if (wakeUp !== undefined) {
    yield* armAlarm(state.storage, wakeUp)
  }
  const program: ClusterWorkflowProgram = {
    run: (payload, options) => Effect.promise(() => getRuntime().run(payload, options)),
    poll: () => Effect.promise(() => getRuntime().poll()),
    resume: (mode) => Effect.promise(() => getRuntime().resume(mode)),
    interrupt: () => Effect.promise(() => getRuntime().interrupt()),
    interruptUnsafe: () => Effect.promise(() => getRuntime().interruptUnsafe()),
    deferredDone: (deferredName, exit) => Effect.promise(() => getRuntime().deferredDone(deferredName, exit)),
    scheduleClock: (clockName, deferredName, wakeAt) =>
      Effect.promise(() => getRuntime().scheduleClock(clockName, deferredName, wakeAt)),
    // No stored execution means no clock could have armed this alarm.
    alarm: () => name === undefined ? Effect.void : Effect.promise(() => getRuntime().runAlarm())
  }
  return program
})

/**
 * Item leased from the durable queue program.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export interface DurableQueueItem {
  readonly id: string
  readonly element: string
  readonly attempts: number
}

/**
 * Effect-valued program for one durable queue Durable Object.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type ClusterDurableQueueProgram = {
  readonly offer: (
    id: string,
    element: string,
    delayMillis?: number,
    deduplicate?: "untilExecuted" | "untilRemoved"
  ) => Effect.Effect<void>
  readonly take: (takerId: string, maxAttempts: number, leaseMillis: number) => Effect.Effect<DurableQueueItem>
  readonly cancelTake: (takerId: string) => Effect.Effect<void>
  readonly complete: (id: string, takerId: string) => Effect.Effect<void>
  readonly fail: (
    id: string,
    lastFailure: string,
    takerId: string,
    terminal?: boolean,
    retryDelayMillis?: number
  ) => Effect.Effect<void>
  readonly release: (id: string, takerId: string) => Effect.Effect<void>
  readonly extend: (id: string, leaseMillis: number, takerId: string) => Effect.Effect<void>
  readonly alarm: () => Effect.Effect<void>
}

/**
 * Creates the program behind one durable queue Durable Object.
 *
 * **When to use**
 *
 * Use when a framework creates the native Durable Object class itself and
 * needs the queue persistence, leasing, and alarm behavior without extending
 * the bundled `ClusterDurableQueue` class.
 *
 * **Details**
 *
 * Run the returned Effect once per Durable Object activation. It ensures the
 * queue table and re-arms the single alarm from the earliest pending lease
 * expiry before returning the handler object.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.3
 */
export const makeClusterDurableQueueProgram = Effect.fnUntraced(function*(state: DurableObjectProgramState) {
  const clock = yield* Clock.Clock
  if (state.id.name !== undefined && decodeName(state.id.name) === undefined) {
    return yield* Effect.die(new Error("ClusterDurableQueue requires a canonical queue Durable Object name"))
  }
  const runtime = makeQueueRuntime({
    sql: state.storage.sql,
    alarm: state.storage,
    now: () => clock.currentTimeMillisUnsafe()
  })
  const expiry = earliestLeaseExpiry(state.storage.sql)
  if (expiry !== undefined) {
    yield* armAlarm(state.storage, expiry)
  }
  const program: ClusterDurableQueueProgram = {
    offer: (id, element, delayMillis, deduplicate) =>
      Effect.promise(() => runtime.offer(id, element, delayMillis, deduplicate)),
    take: (takerId, maxAttempts, leaseMillis) => Effect.promise(() => runtime.take(takerId, maxAttempts, leaseMillis)),
    cancelTake: (takerId) => Effect.promise(() => runtime.cancelTake(takerId)),
    complete: (id, takerId) => Effect.promise(() => runtime.complete(id, takerId)),
    fail: (id, lastFailure, takerId, terminal, retryDelayMillis) =>
      Effect.promise(() => runtime.fail(id, lastFailure, takerId, terminal, retryDelayMillis)),
    release: (id, takerId) => Effect.promise(() => runtime.release(id, takerId)),
    extend: (id, leaseMillis, takerId) => Effect.promise(() => runtime.extend(id, leaseMillis, takerId)),
    alarm: () => Effect.promise(() => runtime.runAlarm())
  }
  return program
})

/**
 * Effect-valued program for one cluster singleton Durable Object.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type ClusterSingletonProgram = {
  readonly wake: () => Effect.Effect<SingletonWakeResult>
  readonly alarm: () => Effect.Effect<void>
}

/**
 * How one singleton wake ended.
 *
 * **Details**
 *
 * A failed singleton run resolves `wake()` with a `Failure` instead of
 * rejecting it, so a rejected `wake()` always means the call itself failed in
 * transit and is safe to retry. Retrying a failed run would rerun user code.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export type SingletonWakeResult =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly message: string }

const wakeSuccess: SingletonWakeResult = { _tag: "Success" }

/**
 * Creates the program behind one cluster singleton Durable Object.
 *
 * **When to use**
 *
 * Use when a framework creates the native Durable Object class itself and
 * needs the singleton wake and watchdog behavior without extending the
 * bundled `ClusterSingleton` class.
 *
 * **Details**
 *
 * Run the returned Effect once per Durable Object activation, after the
 * Worker application (the singleton registrations) is initialized. It ensures
 * the singleton state table and re-arms the watchdog alarm for a wake
 * interrupted by isolate loss before returning the handler object.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.3
 */
export const makeClusterSingletonProgram = Effect.fnUntraced(function*(state: DurableObjectProgramState) {
  const clock = yield* Clock.Clock
  const sql = state.storage.sql
  ensureSingletonStorage(sql)
  if (state.id.name !== undefined) {
    if (!state.id.name.startsWith("Singleton/")) {
      return yield* Effect.die(new Error("ClusterSingleton requires a Singleton/<name> Durable Object name"))
    }
    rememberSingletonName(sql, state.id.name)
  }
  const stored = loadSingletonState(sql)
  const name = state.id.name ?? stored.name
  let runtime: ReturnType<typeof makeSingletonRuntime> | undefined
  const getRuntime = () => {
    if (runtime !== undefined) return runtime
    if (name === undefined) {
      throw new Error("ClusterSingleton requires a Singleton/<name> Durable Object name")
    }
    const singletonName = name.slice("Singleton/".length)
    const registration = getSingletonRegistration(singletonName)
    if (registration === undefined) {
      throw new Error(`CloudflareCluster: no singleton registered under the name "${singletonName}"`)
    }
    const run = Effect.sync(() => {
      ClusterMetrics.singletons.modifyUnsafe(BigInt(1), registration.context)
    }).pipe(
      Effect.andThen(registration.run),
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => {
        ClusterMetrics.singletons.modifyUnsafe(BigInt(-1), registration.context)
      })),
      Effect.provideContext(registration.context),
      Effect.orDie
    )
    runtime = makeSingletonRuntime({
      sql,
      alarm: state.storage,
      now: () => clock.currentTimeMillisUnsafe(),
      run
    })
    return runtime
  }
  if (stored.wakeAt !== undefined) {
    yield* armAlarm(state.storage, stored.wakeAt)
  }
  const program: ClusterSingletonProgram = {
    wake: () =>
      Effect.promise(() => getRuntime().wake()).pipe(
        Effect.as(wakeSuccess),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError("Singleton run failed", cause),
            { _tag: "Failure", message: Cause.pretty(cause) } as const
          )
        )
      ),
    alarm: () =>
      Effect.suspend(() =>
        loadSingletonState(sql).wakeAt === undefined ? Effect.void : Effect.promise(() => getRuntime().runAlarm())
      )
  }
  return program
})
