/** @internal */
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as Cause from "effect/Cause"
import * as ClusterMetrics from "effect/cluster/ClusterMetrics"
import { isUninterruptibleForServer, Persisted } from "effect/cluster/ClusterSchema"
import { CurrentAddress, CurrentRunnerAddress, KeepAliveHandler, Request } from "effect/cluster/Entity"
import type * as EntityAddress from "effect/cluster/EntityAddress"
import * as Envelope from "effect/cluster/Envelope"
import * as Reply from "effect/cluster/Reply"
import * as RunnerAddress from "effect/cluster/RunnerAddress"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Pull from "effect/Pull"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcMessage from "effect/rpc/RpcMessage"
import * as RpcSchema from "effect/rpc/RpcSchema"
import * as RpcServer from "effect/rpc/RpcServer"
import type * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type { EntityDeliveryOptions, EntityInvokeResult } from "../CloudflareDurableObjectPrograms.ts"
import { encodeName } from "./clusterName.ts"
import type { EntityKeepAlive } from "./entityKeepAlive.ts"
import {
  ackChunk,
  clearReplies,
  completeTell,
  loadMessage,
  loadNextReply,
  loadUnprocessed,
  persistRequest,
  type PersistResult,
  type ReplyTarget,
  saveReply,
  type StoredMessage
} from "./entityMailbox.ts"
import { type EntityRegistration, getEntityRegistration, keepAliveHeartbeatMillis } from "./entityRegistry.ts"
import { CurrentEntityName, CurrentReplyRegistry, type EntityReplyRegistry, makeReplyRegistry } from "./entityReply.ts"
import { type EntitySql, makeEntitySql } from "./entitySql.ts"
import {
  armAlarm,
  earliestDeliverAt,
  loadEntityState,
  nextAlarmAt,
  saveKeepAlive,
  withTransaction
} from "./entityStorage.ts"
import { decodeReplyFor, decodeRequest, encodeReplyFor, peekEnvelopeTag } from "./entityWire.ts"

interface CachedHandlers {
  readonly handlers: Record<string, (request: any) => any>
  readonly context: Context.Context<never>
  readonly scope: Scope.Closeable
  readonly server: ServerHandle
}

// A build's `RpcServer`. It outlives a defect rebuild so requests already
// running on it finish there; once retired, it closes when the last request
// holding a lease on it ends.
interface ServerHandle {
  readonly server: RpcServer.RpcServer<any>
  readonly scope: Scope.Closeable
  leases: number
  retired: boolean
  closed: boolean
}

// One request written to the wake's `RpcServer`. A defect retry writes a new
// server request, so ids are never reused while a previous fiber unwinds.
interface ServerRequest {
  readonly envelope: Envelope.Request.Any
  readonly discard: boolean
  readonly respond: (reply: Reply.Reply<any>) => Effect.Effect<void>
  readonly progress: {
    lastSentChunk: Option.Option<Reply.Chunk<any>>
    sequence: number
  }
  readonly exit: Deferred.Deferred<Exit.Exit<unknown, unknown>>
  // Completes once the server's request effect, including its request scope,
  // has finished.
  readonly finished: Deferred.Deferred<void>
  started: boolean
  interrupted: boolean
  fork: boolean
}

/** @internal */
export const makeEntityRuntime = Effect.fnUntraced(function*(
  registration: EntityRegistration,
  address: EntityAddress.EntityAddress,
  nextId: () => string,
  entityName = encodeName(address.entityType, address.entityId),
  keepAlive?: EntityKeepAlive,
  replyRegistry?: EntityReplyRegistry,
  entitySql?: EntitySql
) {
  let cached: CachedHandlers | undefined
  let building: Deferred.Deferred<CachedHandlers> | undefined
  const metricContext = Context.merge(
    registration.context,
    Metric.CurrentMetricAttributes.context({ type: registration.entity.type })
  )
  // Bounds concurrent handler executions from the entity's `concurrency`
  // build option; `"unbounded"` leaves handlers unlimited.
  const concurrency = registration.options?.concurrency ?? 1
  const handlerSemaphore = concurrency === "unbounded" ? undefined : Semaphore.makeUnsafe(concurrency)

  const serverRequests = new Map<number, ServerRequest>()
  let nextServerRequestId = 0
  // Set while `server.write` runs; a request the server rejects before it
  // forks a handler is answered with a `Defect` that carries no request id.
  let writing: ServerRequest | undefined

  const onFromServer = (response: RpcMessage.FromServer<any>): Effect.Effect<void> => {
    switch (response._tag) {
      case "Exit": {
        const request = serverRequests.get(Number(response.requestId))
        if (request !== undefined) Deferred.doneUnsafe(request.exit, Effect.succeed(response.exit))
        return Effect.void
      }
      case "Chunk": {
        const request = serverRequests.get(Number(response.requestId))
        if (request === undefined || request.discard || request.interrupted) return Effect.void
        const progress = request.progress
        const reply = new Reply.Chunk({
          requestId: request.envelope.requestId,
          id: nextId() as any,
          sequence: progress.sequence++,
          values: response.values as any
        })
        return request.respond(reply).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              progress.lastSentChunk = Option.some(reply)
            })
          ),
          // The server ends the request without an exit after a failed chunk
          // write, so the failure becomes the request's exit here.
          Effect.onError((cause) =>
            Effect.sync(() => {
              if (!Cause.hasInterruptsOnly(cause)) {
                Deferred.doneUnsafe(request.exit, Effect.succeed(Exit.failCause(cause)))
              }
            })
          )
        )
      }
      case "Defect": {
        if (writing !== undefined) Deferred.doneUnsafe(writing.exit, Effect.succeed(Exit.die(response.defect)))
        return Effect.void
      }
      case "ClientEnd":
        return Effect.void
    }
  }

  // Closes a retired server once nothing holds a lease on it. `closed` is set
  // synchronously, so a lease taken afterwards moves to the current build.
  const closeIfDrained = (handle: ServerHandle): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!handle.retired || handle.leases > 0 || handle.closed) return Effect.void
      handle.closed = true
      return Scope.close(handle.scope, Exit.void)
    })

  const invalidate = Effect.fnUntraced(function*() {
    if (cached === undefined) return
    const scope = cached.scope
    const server = cached.server
    cached = undefined
    server.retired = true
    yield* closeIfDrained(server)
    // The closing build's holders are gone with it. `EntityResource` skips
    // `keepAlive(false)` while its scope shuts down, so keeping the count
    // would leak a holder into the rebuild.
    keepAlive?.resetHolders()
    yield* Scope.close(scope, Exit.void).pipe(
      Effect.ensuring(Effect.sync(() => {
        ClusterMetrics.entities.modifyUnsafe(BigInt(-1), metricContext)
      }))
    )
  })

  const buildHandlers = Effect.fnUntraced(function*() {
    const scope = yield* Scope.make()
    let context = registration.context.pipe(
      Context.add(CurrentAddress, address),
      Context.add(CurrentRunnerAddress, RunnerAddress.make(`${address.entityType}/${address.entityId}`, 0)),
      Context.add(CurrentEntityName, entityName),
      Context.add(Scope.Scope, scope)
    )
    if (keepAlive !== undefined) {
      context = Context.add(context, KeepAliveHandler, keepAlive.update)
    }
    if (replyRegistry !== undefined) {
      context = Context.add(context, CurrentReplyRegistry, replyRegistry)
    }
    const { handlers, server } = yield* Effect.gen(function*() {
      if (entitySql !== undefined) {
        context = Context.merge(context, yield* Scope.provide(entitySql.make, scope))
      }
      const handlers = yield* Effect.provideContext(registration.build, context)
      // The server sees each handler's result before it takes a permit; a
      // forked result is marked here so its request skips the entity permit.
      const serverHandlers: Record<string, (payload: any, options: { readonly requestId: any }) => any> = {}
      for (const tag of Object.keys(handlers)) {
        const handler = handlers[tag]
        serverHandlers[tag] = (request, { requestId }) => {
          const result = handler(request)
          if (Rpc.isWrapper(result as object) && (result as Rpc.Wrapper<unknown>).fork) {
            const pending = serverRequests.get(Number(requestId))
            if (pending !== undefined) pending.fork = true
          }
          return result
        }
      }
      const handlersContext: Context.Context<never> = yield* Effect.provideContext(
        registration.entity.protocol.toHandlers(serverHandlers),
        context as Context.Context<any>
      )
      const serverScope = yield* Scope.make()
      // Middleware services come from the registration context: `Entity.toLayer`
      // requires them, and `registerEntity` captures that context.
      const server = yield* (RpcServer.makeNoSerialization(registration.entity.protocol, {
        onFromServer,
        concurrency: "unbounded",
        disableTracing: true,
        disableClientAcks: true,
        disableFatalDefects: true
      }) as Effect.Effect<RpcServer.RpcServer<any>, never, Scope.Scope>).pipe(
        Effect.provideContext(Context.add(Context.merge(context, handlersContext), Scope.Scope, serverScope))
      )
      const handle: ServerHandle = { server, scope: serverScope, leases: 0, retired: false, closed: false }
      return { handlers, server: handle }
    }).pipe(
      Effect.tapCause((cause) => Scope.close(scope, Exit.failCause(cause)))
    )
    ClusterMetrics.entities.modifyUnsafe(BigInt(1), metricContext)
    // Any event that builds the entity restores a hold persisted before a
    // restart.
    keepAlive?.restore()
    return { handlers, context, scope, server } satisfies CachedHandlers
  })

  const getHandlers = (): Effect.Effect<CachedHandlers> =>
    Effect.suspend(() => {
      if (cached !== undefined) return Effect.succeed(cached)
      if (building !== undefined) return Deferred.await(building)
      const deferred = Deferred.makeUnsafe<CachedHandlers>()
      building = deferred
      return Effect.onExit(buildHandlers(), (exit) =>
        Effect.sync(() => {
          building = undefined
          if (Exit.isSuccess(exit)) cached = exit.value
          Deferred.doneUnsafe(deferred, exit)
        }))
    })

  const runWithDefectRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const policy = registration.options?.defectRetryPolicy
    if (policy === undefined) return Effect.exit(effect)
    const retryable = Effect.flatMap(Effect.exit(effect), (exit) =>
      Exit.isFailure(exit) && Cause.hasDies(exit.cause)
        ? Effect.fail(exit.cause)
        : Effect.succeed(exit))
    return Effect.retryOrElse(
      retryable,
      policy as Schedule.Schedule<unknown, Cause.Cause<E>>,
      (cause) => Effect.succeed(Exit.failCause(cause))
    )
  }

  // Takes a lease on the current build's server for one request, including
  // its defect retries. Only the build itself stays interruptible. A server
  // that closed after `getHandlers` returned it is no longer cached, so the
  // lookup runs again.
  const leaseHandlers = (
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  ): Effect.Effect<CachedHandlers> =>
    Effect.flatMap(restore(getHandlers()), (entry) =>
      Effect.suspend(() => {
        if (entry.server.closed) return leaseHandlers(restore)
        entry.server.leases++
        return Effect.succeed(entry)
      }))

  const releaseLease = (entry: CachedHandlers): Effect.Effect<void> =>
    Effect.suspend(() => {
      entry.server.leases--
      return closeIfDrained(entry.server)
    })

  const rebuildAfterDefect = invalidate().pipe(
    Effect.andThen(Effect.catchCause(getHandlers(), () => Effect.void))
  )

  // Writes one attempt to the server and waits for its exit and for the
  // request scope to close. Interrupting the caller interrupts the server
  // request and still waits, so an `Rpc.uninterruptible` handler finishes
  // before the caller's interruption completes.
  const runOnServer = (
    server: RpcServer.RpcServer<any>,
    request: ServerRequest,
    permit: HandlerPermit
  ): Effect.Effect<unknown, unknown> => {
    const id = nextServerRequestId++
    const settled = Effect.flatMap(
      Deferred.await(request.exit),
      (exit) => request.started ? Effect.as(Deferred.await(request.finished), exit) : Effect.succeed(exit)
    )
    // `finished` completes on every exit of the request effect, including an
    // interrupt while it waits for the permit or before the handler starts.
    // `started` is set inside the `ensuring`, so `settled` only waits for
    // `finished` once the finalizer is registered.
    const onRequest = <X, E, R>(effect: Effect.Effect<X, E, R>): Effect.Effect<X, E, R> =>
      Effect.ensuring(
        Effect.suspend(() => {
          request.started = true
          if (request.interrupted) return Effect.interrupt
          return request.fork ? effect : permit.acquire(effect)
        }),
        Effect.sync(() => Deferred.doneUnsafe(request.finished, Effect.void))
      )
    const write = Effect.suspend(() => {
      serverRequests.set(id, request)
      writing = request
      return server.write(0, {
        _tag: "Request",
        id: RpcMessage.RequestId(id),
        tag: request.envelope.tag,
        payload: new Request({ ...request.envelope, lastSentChunk: request.progress.lastSentChunk }),
        headers: request.envelope.headers
      }, { onRequest }).pipe(
        Effect.ensuring(Effect.sync(() => {
          writing = undefined
        }))
      )
    })
    // The write and the interrupt hook are installed without an interruptible
    // gap, so an interrupt that arrives just after the write still reaches
    // the server request.
    return Effect.uninterruptibleMask((restore) =>
      Effect.andThen(
        write,
        Effect.onInterrupt(restore(settled), () =>
          Effect.suspend(() => {
            request.interrupted = true
            const stop = request.started
              ? server.write(0, { _tag: "Interrupt", requestId: RpcMessage.RequestId(id), interruptors: [] })
              : Effect.void
            return Effect.andThen(stop, settled)
          }))
      )
    ).pipe(
      Effect.flatten,
      Effect.ensuring(Effect.sync(() => serverRequests.delete(id)))
    )
  }

  const run = (
    envelope: Envelope.Request.Any,
    lastSentChunk: Option.Option<Reply.Chunk<any>>,
    discard: boolean,
    respond: (reply: Reply.Reply<any>) => Effect.Effect<void>,
    permit: HandlerPermit = makeHandlerPermit(handlerSemaphore)
  ): Effect.Effect<void> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(leaseHandlers(restore), (entry) =>
        Effect.ensuring(
          restore(runLeased(entry, envelope, lastSentChunk, discard, respond, permit)),
          releaseLease(entry)
        ))
    )

  const runLeased = Effect.fnUntraced(function*(
    entry: CachedHandlers,
    envelope: Envelope.Request.Any,
    lastSentChunk: Option.Option<Reply.Chunk<any>>,
    discard: boolean,
    respond: (reply: Reply.Reply<any>) => Effect.Effect<void>,
    permit: HandlerPermit
  ) {
    const rpc = registration.entity.protocol.requests.get(envelope.tag) as Rpc.AnyWithProps | undefined
    const handler = entry.handlers[envelope.tag]
    if (rpc === undefined || handler === undefined) {
      const exit = Exit.die(`Unknown entity RPC tag: ${envelope.tag}`)
      if (!discard) {
        yield* respond(
          new Reply.WithExit({
            requestId: envelope.requestId,
            id: nextId() as any,
            exit
          })
        )
      }
      return
    }

    const streamSchema = RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema : undefined
    const progress = {
      lastSentChunk,
      sequence: Option.match(lastSentChunk, {
        onNone: () => 0,
        onSome: (chunk) => chunk.sequence + 1
      })
    }

    const execute = Effect.suspend(() =>
      runOnServer(entry.server.server, {
        envelope,
        discard,
        respond,
        progress,
        exit: Deferred.makeUnsafe(),
        finished: Deferred.makeUnsafe(),
        started: false,
        interrupted: false,
        fork: false
      }, permit)
    ).pipe(
      Effect.withSpan("CloudflareCluster.handler", {
        attributes: {
          entityType: registration.entity.type,
          entityId: String(address.entityId),
          rpc: envelope.tag
        }
      }, { captureStackTrace: false })
    )
    const exit = yield* Effect.provideContext(runWithDefectRetry(execute), entry.context)
    if (!discard) {
      yield* respond(
        new Reply.WithExit({
          requestId: envelope.requestId,
          id: nextId() as any,
          exit: streamSchema !== undefined && Exit.isSuccess(exit) ? Exit.void : exit as any
        })
      )
    }
    if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
      yield* rebuildAfterDefect
    }
  })

  // Builds the handlers without running a request, for wakes that only need
  // the entity alive. Building restores the hold; the explicit `restore`
  // covers an entity that was already built when its hold ended.
  const warm: Effect.Effect<void> = Effect.andThen(getHandlers(), Effect.sync(() => keepAlive?.restore()))

  return { run, invalidate, warm, handlerSemaphore } as const
})

type EntityRuntime = Effect.Success<ReturnType<typeof makeEntityRuntime>>

interface SessionReply {
  readonly text: string
  readonly terminal: boolean
}

interface Session {
  readonly queue: Queue.Queue<SessionReply, Cause.Done>
  readonly completeInterrupt: Effect.Effect<void>
  // `ClusterSchema.Uninterruptible` is `true` or `"server"`: an interrupt is
  // ignored and the handler runs to completion.
  readonly uninterruptible: boolean
  cancelling: boolean
  ack: {
    readonly replyId: string
    readonly deferred: Deferred.Deferred<void>
  } | undefined
  fiber: Fiber.Fiber<void> | undefined
  // Completed when the handler saves its next reply or exits, for duplicates
  // of a persisted stream that arrived before that reply existed.
  saved: Deferred.Deferred<void> | undefined
}

interface WorkerWaiter {
  readonly clientRequestId: string
  readonly deferred: Deferred.Deferred<EntityInvokeResult>
}

interface RunOptions {
  readonly scheduled?: boolean
  readonly replyTos?: ReadonlyArray<ReplyTarget> | undefined
}

/** @internal */
export interface EntityManagerOptions {
  readonly storage: DurableObjectStorage
  readonly address: EntityAddress.EntityAddress
  readonly entityName: string
  readonly keepAlive: EntityKeepAlive
  readonly waitUntil: (effect: Effect.Effect<unknown>) => void
  readonly getNamespace: () => {
    readonly getByName: (name: string) => {
      readonly deliverReply: (requestId: string, reply: string) => Promise<boolean>
    }
  } | undefined
}

/** @internal */
export interface EntityManager {
  readonly invoke: (
    envelopeText: string,
    discard: boolean,
    delivery?: EntityDeliveryOptions | undefined
  ) => Effect.Effect<EntityInvokeResult>
  readonly acknowledge: (requestId: string, replyId: string) => Effect.Effect<ReadonlyArray<string>>
  readonly interrupt: (storageRequestId: string, clientRequestId?: string) => Effect.Effect<void>
  readonly reset: (requestId: string) => Effect.Effect<void>
  readonly alarm: Effect.Effect<void>
  readonly deliverReply: (requestId: string, reply: string) => Effect.Effect<boolean>
  /** Writes the keep-alive flag and moves the alarm to match it. */
  readonly saveKeepAlive: (wanted: boolean) => Effect.Effect<void>
}

const success = (requestId: string, replies: ReadonlyArray<string>): EntityInvokeResult => ({
  _tag: "Success",
  requestId,
  replies
})

interface HandlerPermit {
  readonly acquire: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly pause: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const unlimitedHandlerPermit: HandlerPermit = { acquire: identity, pause: identity }

/**
 * One permit per handler execution. `acquire` holds the permit for the whole
 * run; `pause` gives it back while a chunk is parked on its client
 * acknowledgement so an unacked stream cannot starve other handlers. The
 * `held` flag keeps take/release balanced when interruption lands inside a
 * paused section: a pause that never re-acquires leaves `held` false, and
 * `acquire` then skips its release.
 */
const makeHandlerPermit = (semaphore: Semaphore.Semaphore | undefined): HandlerPermit => {
  if (semaphore === undefined) return unlimitedHandlerPermit
  let held = false
  return {
    acquire: (effect) =>
      Effect.uninterruptibleMask((restore) =>
        restore(Semaphore.take(semaphore, 1)).pipe(
          Effect.flatMap(() => {
            held = true
            return restore(effect)
          }),
          Effect.onExit(() =>
            Effect.suspend(() => {
              if (!held) return Effect.void
              held = false
              return Effect.asVoid(Semaphore.release(semaphore, 1))
            })
          )
        )
      ),
    pause: (effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (!held) return restore(effect)
          held = false
          return Semaphore.release(semaphore, 1).pipe(
            Effect.flatMap(() => restore(effect)),
            Effect.flatMap((value) =>
              Effect.map(restore(Semaphore.take(semaphore, 1)), () => {
                held = true
                return value
              })
            )
          )
        })
      )
  }
}

/**
 * The Effect-land state machine behind one `ClusterEntity` Durable Object.
 * The class methods are one-line `Effect.runPromise` adapters over the
 * effects returned here; all serialization, sessions, and waiters live in
 * Effect primitives.
 *
 * @internal
 */
export const makeEntityManager = (options: EntityManagerOptions): EntityManager => {
  const storage = options.storage
  const sql = storage.sql
  // Serializes storage entry: envelope decode, persist-before-run, dedupe,
  // duplicate resume, and alarm arming. Handler execution runs in forked
  // fibers governed by the handler concurrency semaphore below.
  const semaphore = Semaphore.makeUnsafe(1)
  const sessions = new Map<string, Session>()
  // Persisted discard/scheduled requests with an in-flight handler; guards
  // against a second execution from replay or duplicate delivery in the same
  // wake, the way `sessions` does for asks.
  const pendingRuns = new Set<string>()
  // Sessions can retain queued replies after their handler has finished, and
  // can also belong to non-persisted requests. Count persisted handler fibers
  // separately so only transitions touch the recovery alarm.
  let inFlightPersisted = 0
  const workerWaiters = new Map<string, Array<WorkerWaiter>>()
  const replyRegistry = makeReplyRegistry()
  const entitySql = makeEntitySql(storage)
  // Every mailbox write runs in its own storage transaction and waits for any
  // open user transaction, so a user rollback cannot take a reply with it.
  const write = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    entitySql.guard(withTransaction(storage, effect))
  let runtime: EntityRuntime | undefined

  const getRuntime = (registration: EntityRegistration): Effect.Effect<EntityRuntime> =>
    runtime !== undefined ? Effect.succeed(runtime) : Effect.map(
      makeEntityRuntime(
        registration,
        options.address,
        () => crypto.randomUUID(),
        options.entityName,
        options.keepAlive,
        replyRegistry,
        entitySql
      ),
      (built) => runtime = built
    )

  const armEarliestAlarm = Effect.suspend(() => {
    const deliverAt = earliestDeliverAt(sql)
    return deliverAt === undefined ? Effect.void : armAlarm(storage, deliverAt)
  })

  const heartbeatMillis = () => keepAliveHeartbeatMillis(options.address.entityType)

  const isRunning = (requestId: string) => sessions.has(requestId) || pendingRuns.has(requestId)

  // Hot paths only ever move the alarm earlier. A heartbeat while a persisted
  // row runs leaves an alarm behind for the restart that kills its handler.
  const armHeartbeat = Effect.suspend(() => armAlarm(storage, Date.now() + heartbeatMillis()))

  // Recomputes the single alarm from the whole entity state. Callers hold the
  // entry permit, so a concurrent keep-alive write cannot slip in between the
  // read and a `deleteAlarm`.
  const rearm = Effect.suspend(() => {
    const next = nextAlarmAt(sql, { now: Date.now(), heartbeatMillis: heartbeatMillis(), isRunning })
    return Effect.flatMap(
      Effect.promise(() => storage.getAlarm()),
      (current) => {
        if (next !== undefined) {
          return current === next ? Effect.void : Effect.promise(() => storage.setAlarm(next))
        }
        return current === null ? Effect.void : Effect.promise(() => storage.deleteAlarm())
      }
    )
  })

  // Called under the entry permit, before forking the handler. Overlapping
  // requests share the first heartbeat instead of reading the alarm per run.
  const startPersisted = Effect.suspend(() => ++inFlightPersisted === 1 ? armHeartbeat : Effect.void)

  // Handler finalizers hold the entry permit and finish mailbox writes before
  // dropping the count. The last completion may move the alarm later to a
  // scheduled delivery, retain keep-alive, or remove it entirely.
  const finishPersisted = Effect.suspend(() => --inFlightPersisted === 0 ? rearm : Effect.void)

  const removeSession = (requestId: string, session: Session) => {
    if (!session.cancelling && sessions.get(requestId) === session) sessions.delete(requestId)
  }

  const signalSaved = (session: Session) => {
    const saved = session.saved
    if (saved === undefined) return
    session.saved = undefined
    Deferred.doneUnsafe(saved, Effect.void)
  }

  const storedNextReply = (requestId: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.map(loadNextReply(sql, requestId), (nextReply) => nextReply === undefined ? [] : [nextReply.reply])

  // Reads the next stored reply of a running persisted stream, waiting for
  // the handler to save one when there is none yet. The waiter is registered
  // before reading storage, so a reply saved in between still wakes it.
  const awaitStoredReply = (requestId: string, session: Session): Effect.Effect<Effect.Effect<ReadonlyArray<string>>> =>
    Effect.suspend(() => {
      const saved = session.saved ??= Deferred.makeUnsafe<void>()
      return Effect.map(
        loadNextReply(sql, requestId),
        (nextReply) =>
          nextReply === undefined
            ? Effect.andThen(Deferred.await(saved), storedNextReply(requestId))
            : Effect.succeed([nextReply.reply])
      )
    })

  const takeReply = (requestId: string, session: Session): Effect.Effect<ReadonlyArray<string>> =>
    Queue.take(session.queue).pipe(
      Effect.map((reply) => {
        if (reply.terminal) removeSession(requestId, session)
        return [reply.text]
      }),
      Pull.catchDone(() => Effect.succeed([]))
    )

  // Hands a scheduled reply to the pinned callers waiting in this wake and
  // returns the reply targets stored now, which include any a duplicate added
  // while the handler ran. Runs after the reply is saved: once the row is
  // processed, a later duplicate reads the stored reply instead.
  const settleScheduledReply = (
    requestId: string,
    reply: string,
    replyTos: ReadonlyArray<ReplyTarget> | undefined
  ): Effect.Effect<ReadonlyArray<ReplyTarget> | undefined> =>
    Effect.map(loadMessage(sql, requestId), (message) => {
      const waiters = workerWaiters.get(requestId)
      if (waiters !== undefined) {
        workerWaiters.delete(requestId)
        for (const waiter of waiters) {
          Deferred.doneUnsafe(waiter.deferred, Effect.succeed(success(requestId, [reply])))
        }
      }
      return message === undefined ? replyTos : message.replyTos
    })

  const pushScheduledReply = (
    reply: string,
    replyTos: ReadonlyArray<ReplyTarget> | undefined
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (replyTos === undefined) return Effect.void
      const namespace = options.getNamespace()
      if (namespace === undefined) {
        return Effect.logError(
          "Scheduled entity reply delivery failed",
          new Error("CloudflareCluster: ClusterEntity export is unavailable for scheduled reply delivery")
        )
      }
      return Effect.forEach(
        replyTos,
        ({ replyTo, requestId }) =>
          Effect.promise(() => namespace.getByName(replyTo).deliverReply(requestId, reply)).pipe(
            Effect.flatMap((delivered) =>
              delivered
                ? Effect.void
                : Effect.logError(
                  "Scheduled entity reply delivery failed",
                  new Error(`Scheduled entity reply target is unavailable: ${replyTo}`)
                )
            ),
            Effect.catchCause((cause) => Effect.logError("Scheduled entity reply delivery failed", cause))
          ),
        { concurrency: "unbounded", discard: true }
      )
    })

  const deliverScheduledReply = (
    requestId: string,
    reply: string,
    replyTos: ReadonlyArray<ReplyTarget> | undefined
  ): Effect.Effect<void> =>
    Effect.flatMap(
      settleScheduledReply(requestId, reply, replyTos),
      (targets) => pushScheduledReply(reply, targets)
    )

  // Runs one request under the entry permit up to forking its handler fiber,
  // then returns a continuation that awaits the handler output. Callers run
  // the continuation after the entry permit is released so handlers governed
  // by the concurrency semaphore can interleave with later storage entries.
  const run = Effect.fnUntraced(function*(
    registration: EntityRegistration,
    entityRuntime: EntityRuntime,
    envelope: Envelope.Request.Any,
    lastSentChunkText: string | undefined,
    discard: boolean,
    persisted: boolean,
    runOptions?: RunOptions
  ) {
    const rpc = registration.entity.protocol.requests.get(envelope.tag) as Rpc.AnyWithProps
    let lastSentChunk = Option.none<Reply.Chunk<any>>()
    if (lastSentChunkText !== undefined) {
      const reply = yield* decodeReplyFor(rpc, registration.context, lastSentChunkText)
      if (reply._tag === "Chunk") lastSentChunk = Option.some(reply)
    }
    const requestId = String(envelope.requestId)
    if (!discard) {
      const active = sessions.get(requestId)
      if (active !== undefined) {
        // A stream duplicate resumes from storage, as on other runners.
        if (persisted && RpcSchema.isStreamSchema(rpc.successSchema)) {
          return yield* awaitStoredReply(requestId, active)
        }
        const nextReply = persisted ? yield* loadNextReply(sql, requestId) : undefined
        if (nextReply !== undefined) return Effect.succeed([nextReply.reply])
        const fiber = active.fiber
        if (!persisted || fiber === undefined) return Effect.succeed([])
        // A unary duplicate waits for the handler outside the entry permit and
        // then reads its stored reply, which wins even when post-reply handler
        // cleanup failed.
        return Effect.gen(function*() {
          const exit = yield* Fiber.await(fiber)
          const reply = yield* loadNextReply(sql, requestId)
          if (reply !== undefined) return [reply.reply]
          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
          return yield* Effect.die("Persisted unary handler finished without a reply")
        })
      }
    }

    const scheduled = runOptions?.scheduled === true
    if (discard || scheduled) {
      if (persisted) {
        if (pendingRuns.has(requestId)) return Effect.succeed([])
        pendingRuns.add(requestId)
        yield* startPersisted
      }
      // No stream acks on this path, so the runtime's plain permit is enough.
      const execute = entityRuntime.run(envelope, lastSentChunk, discard, (reply) =>
        Effect.gen(function*() {
          const encoded = yield* encodeReplyFor(registration, rpc, reply)
          const save = persisted ? Effect.orDie(write(saveReply(sql, encoded))) : Effect.void
          if (!scheduled || reply._tag !== "WithExit") return yield* save
          // Saving the terminal reply, settling the waiters and reading the
          // targets share the entry permit, so a duplicate entry either finds
          // the stored reply or is registered in time to receive it.
          const replyTos = yield* Semaphore.withPermit(
            semaphore,
            Effect.andThen(save, settleScheduledReply(requestId, encoded, runOptions?.replyTos))
          )
          yield* pushScheduledReply(encoded, replyTos)
        }))
      const fiber = yield* Effect.forkDetach(
        execute.pipe(
          Effect.onExit((exit) =>
            !persisted ? Effect.void : Semaphore.withPermit(
              semaphore,
              Effect.suspend(() => {
                pendingRuns.delete(requestId)
                return discard && Exit.isSuccess(exit) ? write(completeTell(sql, requestId)) : Effect.void
              }).pipe(Effect.ensuring(finishPersisted))
            )
          )
        )
      )
      options.waitUntil(Fiber.await(fiber))
      return Effect.as(Fiber.join(fiber), [])
    }

    const queue = yield* Queue.make<SessionReply, Cause.Done>()
    const completeInterrupt = persisted
      ? Effect.flatMap(
        encodeReplyFor(
          registration,
          rpc,
          new Reply.WithExit({
            requestId: envelope.requestId,
            id: crypto.randomUUID() as any,
            exit: Exit.interrupt()
          })
        ),
        (reply) =>
          Effect.orDie(
            write(Effect.andThen(clearReplies(sql, requestId), saveReply(sql, reply)))
          )
      )
      : Effect.void
    const session: Session = {
      queue,
      completeInterrupt,
      uninterruptible: isUninterruptibleForServer(rpc.annotations),
      cancelling: false,
      ack: undefined,
      fiber: undefined,
      saved: undefined
    }
    sessions.set(requestId, session)
    if (persisted) yield* startPersisted
    const permit = makeHandlerPermit(entityRuntime.handlerSemaphore)
    const respond = Effect.fnUntraced(function*(reply: Reply.Reply<any>) {
      const encoded = yield* encodeReplyFor(registration, rpc, reply)
      if (persisted) {
        yield* Effect.orDie(write(saveReply(sql, encoded)))
        signalSaved(session)
      }
      if (reply._tag === "Chunk") {
        const acknowledged = Deferred.makeUnsafe<void>()
        session.ack = { replyId: String(reply.id), deferred: acknowledged }
        // A false offer means the session was interrupted and the queue
        // ended; awaiting the acknowledgement would then never resume.
        const offered = yield* Queue.offer(queue, { text: encoded, terminal: false })
        if (offered) yield* permit.pause(Deferred.await(acknowledged))
        else session.ack = undefined
      } else {
        yield* Queue.offer(queue, { text: encoded, terminal: true })
      }
    })
    session.fiber = yield* Effect.forkDetach(
      entityRuntime.run(envelope, lastSentChunk, discard, respond, permit).pipe(
        Effect.onExit((exit) => {
          const cleanup = Effect.sync(() => {
            if (Exit.isSuccess(exit)) Queue.endUnsafe(queue)
            else Queue.failCauseUnsafe(queue, exit.cause)
            if (Queue.sizeUnsafe(queue) === 0 && session.ack === undefined) {
              removeSession(requestId, session)
            }
            signalSaved(session)
          })
          return persisted
            ? Semaphore.withPermit(semaphore, Effect.andThen(cleanup, finishPersisted))
            : cleanup
        })
      )
    )
    options.waitUntil(Fiber.await(session.fiber))
    return takeReply(requestId, session)
  })

  const runStored = (
    registration: EntityRegistration,
    entityRuntime: EntityRuntime,
    envelopeText: string,
    lastSentChunk: string | undefined,
    discard: boolean,
    runOptions?: RunOptions
  ) =>
    Effect.flatMap(
      decodeRequest(registration, envelopeText),
      (envelope) => run(registration, entityRuntime, envelope, lastSentChunk, discard, true, runOptions)
    )

  const completeReplayFailure = (
    registration: EntityRegistration,
    row: StoredMessage,
    cause: Cause.Cause<unknown>
  ): Effect.Effect<void> =>
    Effect.suspend(() => peekEnvelopeTag(row.envelope)).pipe(
      Effect.flatMap((tag) => {
        if (row.discard || tag === undefined) {
          return write(completeTell(sql, row.requestId))
        }
        const rpc = registration.entity.protocol.requests.get(tag) as Rpc.AnyWithProps | undefined
        if (rpc === undefined) {
          return write(completeTell(sql, row.requestId))
        }
        return Effect.flatMap(
          encodeReplyFor(
            registration,
            rpc,
            new Reply.WithExit({
              requestId: row.requestId as any,
              id: crypto.randomUUID() as any,
              exit: Exit.failCause(cause)
            })
          ),
          (reply) =>
            write(saveReply(sql, reply)).pipe(
              Effect.andThen(deliverScheduledReply(row.requestId, reply, row.replyTos))
            )
        ).pipe(
          Effect.catchCause(() => write(completeTell(sql, row.requestId)))
        )
      })
    )

  // Phase one runs each row up to forking its handler under the entry
  // permit; the returned fibers observe the handler output and route
  // failures through `completeReplayFailure`.
  const replayRows = (
    registration: EntityRegistration,
    entityRuntime: EntityRuntime,
    rows: ReadonlyArray<StoredMessage>
  ): Effect.Effect<Array<Fiber.Fiber<void>>> =>
    rows.length === 0 ? Effect.succeed([]) : Effect.forEach(
      rows,
      (row) =>
        // An active session or in-flight run already owns this request;
        // replaying it would start a second execution in the same wake.
        isRunning(row.requestId) ? Effect.succeed(undefined) : runStored(
          registration,
          entityRuntime,
          row.envelope,
          row.lastSentChunk,
          row.discard,
          row.deliverAt === undefined
            ? undefined
            : {
              scheduled: true,
              ...(row.replyTos === undefined ? undefined : { replyTos: row.replyTos })
            }
        ).pipe(
          Effect.flatMap((continuation) =>
            Effect.forkDetach(
              Effect.catchCause(
                Effect.asVoid(continuation),
                (cause) => completeReplayFailure(registration, row, cause)
              )
            )
          ),
          Effect.catchCause((cause) => Effect.as(completeReplayFailure(registration, row, cause), undefined))
        )
    ).pipe(
      Effect.map((entries) => entries.filter((entry) => entry !== undefined)),
      Effect.tap((entries) =>
        Effect.sync(() => {
          if (entries.length > 0) options.waitUntil(Fiber.awaitAll(entries))
        })
      )
    )

  // Registers the waiter eagerly (under the entry permit) and returns the
  // await for the caller to run once the permit is released.
  const delayedOutcome = (
    requestId: string,
    discard: boolean,
    replyTo: string | undefined,
    clientRequestId = requestId
  ): Effect.Effect<EntityInvokeResult> => {
    if (discard || replyTo !== undefined) return Effect.succeed(success(requestId, []))
    const deferred = Deferred.makeUnsafe<EntityInvokeResult>()
    const waiters = workerWaiters.get(requestId) ?? []
    waiters.push({ clientRequestId, deferred })
    workerWaiters.set(requestId, waiters)
    return Deferred.await(deferred)
  }

  // Runs the storage entry under the caller-held permit and returns the
  // effect that produces the invoke result after the permit is released.
  const invokeEntry = (
    envelopeText: string,
    discard: boolean,
    delivery: EntityDeliveryOptions | undefined
  ): Effect.Effect<Effect.Effect<EntityInvokeResult>> => {
    const registration = getEntityRegistration(options.address.entityType)
    if (registration === undefined) {
      return Effect.die(`No handlers registered for entity type: ${options.address.entityType}`)
    }
    return Effect.gen(function*() {
      const entityRuntime = yield* getRuntime(registration)
      // Replayed rows run on their own fibers. The handler semaphore already
      // orders them ahead of this request, so the caller does not wait for them.
      yield* Effect.flatMap(
        loadUnprocessed(sql),
        (rows) => replayRows(registration, entityRuntime, rows)
      )
      const finish = (
        requestId: string,
        continuation: Effect.Effect<ReadonlyArray<string>>
      ): Effect.Effect<EntityInvokeResult> => Effect.map(continuation, (replies) => success(requestId, replies))
      // A persisted tell must not pin its caller: the row is durable, so the
      // invoke result is complete once the handler is forked. Failures of the
      // forked machinery leave the row unprocessed for replay on a later
      // wake, so they are only logged here.
      const finishTell = (
        requestId: string,
        continuation: Effect.Effect<ReadonlyArray<string>>
      ): Effect.Effect<Effect.Effect<EntityInvokeResult>> =>
        Effect.as(
          Effect.forkDetach(Effect.catchCause(
            Effect.asVoid(continuation),
            (cause) => Effect.logError("Entity tell execution failed", cause)
          )),
          Effect.succeed(success(requestId, []))
        )

      const envelope = yield* decodeRequest(registration, envelopeText)
      const rpc = registration.entity.protocol.requests.get(envelope.tag) as Rpc.AnyWithProps
      const isPersisted = Context.get(rpc.annotations, Persisted)
      if (!isPersisted) {
        const continuation = yield* run(registration, entityRuntime, envelope, undefined, discard, false)
        return finish(String(envelope.requestId), continuation)
      }

      const persistedResult = yield* Effect.result(
        write(
          persistRequest(
            sql,
            envelopeText,
            delivery?.primaryKey ?? Envelope.primaryKey(envelope),
            discard,
            delivery?.deliverAt,
            delivery?.replyTo
          )
        ).pipe(
          Effect.withSpan("CloudflareCluster.persist", {
            attributes: {
              entityType: registration.entity.type,
              entityId: String(options.address.entityId),
              rpc: envelope.tag
            }
          }, { captureStackTrace: false }),
          Effect.provideContext(registration.context)
        )
      )
      if (Result.isFailure(persistedResult)) {
        return Effect.succeed<EntityInvokeResult>(
          persistedResult.failure._tag === "MailboxFull"
            ? { _tag: "MailboxFull" }
            : { _tag: "EncodedMessageTooLarge" }
        )
      }
      const persisted: PersistResult = persistedResult.success
      if (persisted._tag === "Duplicate") {
        const original = yield* loadMessage(sql, persisted.originalId)
        if (original === undefined) return yield* Effect.die("Duplicate mailbox row disappeared")
        if (original.discard && !discard) {
          return Effect.succeed<EntityInvokeResult>({ _tag: "AskDeduplicatedToTell" })
        }
        const nextReply = yield* loadNextReply(sql, persisted.originalId)
        if (nextReply !== undefined) {
          if (nextReply.kind === "WithExit") {
            const session = sessions.get(persisted.originalId)
            if (session !== undefined) removeSession(persisted.originalId, session)
          }
          return Effect.succeed(success(persisted.originalId, [nextReply.reply]))
        }
        if (persisted.processed) {
          return Effect.succeed(success(persisted.originalId, []))
        }
        if (
          delivery?.deliverAt !== undefined ||
          (original.deliverAt !== undefined && original.deliverAt > Date.now())
        ) {
          yield* armEarliestAlarm
          return delayedOutcome(
            persisted.originalId,
            discard,
            delivery?.replyTo,
            String(envelope.requestId)
          )
        }
        // A scheduled ask past its deadline replies through its waiters and
        // reply targets, not a session. The duplicate joins that execution,
        // starting it if it is not running yet; the waiter is registered
        // first so a run that settles at once still reaches it.
        if (original.deliverAt !== undefined && !original.discard) {
          const outcome = delayedOutcome(
            persisted.originalId,
            discard,
            delivery?.replyTo,
            String(envelope.requestId)
          )
          if (!isRunning(persisted.originalId)) {
            yield* replayRows(registration, entityRuntime, [original])
          }
          return outcome
        }
        const continuation = yield* runStored(
          registration,
          entityRuntime,
          original.envelope,
          original.lastSentChunk,
          original.discard
        )
        return original.discard
          ? yield* finishTell(persisted.originalId, continuation)
          : finish(persisted.originalId, continuation)
      }
      if (delivery?.deliverAt !== undefined) {
        yield* armEarliestAlarm
        return delayedOutcome(String(envelope.requestId), discard, delivery.replyTo)
      }
      const continuation = yield* run(registration, entityRuntime, envelope, undefined, discard, true)
      return discard
        ? yield* finishTell(String(envelope.requestId), continuation)
        : finish(String(envelope.requestId), continuation)
    })
  }

  const invoke = (
    envelopeText: string,
    discard: boolean,
    delivery?: EntityDeliveryOptions | undefined
  ): Effect.Effect<EntityInvokeResult> =>
    Effect.flatten(Semaphore.withPermit(semaphore, invokeEntry(envelopeText, discard, delivery)))

  // An acknowledgement with no session comes after a restart. The stream is
  // replayed from its last acknowledged chunk so the caller gets its next
  // reply instead of waiting on an alarm replay that waits for this ack.
  const resumeAcknowledged = (requestId: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.flatten(Semaphore.withPermit(
      semaphore,
      Effect.gen(function*() {
        const nextReply = yield* loadNextReply(sql, requestId)
        if (nextReply !== undefined) return Effect.succeed([nextReply.reply])
        const registration = getEntityRegistration(options.address.entityType)
        if (registration === undefined) return Effect.succeed([])
        // A session started since the ack was written owns the request.
        const session = sessions.get(requestId)
        if (session !== undefined) return yield* awaitStoredReply(requestId, session)
        if (pendingRuns.has(requestId)) return Effect.succeed([])
        const row = (yield* loadUnprocessed(sql)).find((row) => row.requestId === requestId)
        if (row === undefined || row.discard || row.deliverAt !== undefined) return Effect.succeed([])
        const entityRuntime = yield* getRuntime(registration)
        return yield* runStored(registration, entityRuntime, row.envelope, row.lastSentChunk, false).pipe(
          Effect.catchCause((cause) =>
            Effect.as(completeReplayFailure(registration, row, cause), storedNextReply(requestId))
          )
        )
      })
    ))

  const acknowledge = (requestId: string, replyId: string): Effect.Effect<ReadonlyArray<string>> =>
    write(ackChunk(sql, requestId, replyId)).pipe(
      Effect.flatMap(() => {
        const session = sessions.get(requestId)
        if (session?.ack?.replyId === replyId) {
          const acknowledged = session.ack.deferred
          session.ack = undefined
          Deferred.doneUnsafe(acknowledged, Effect.void)
          return takeReply(requestId, session)
        }
        if (session === undefined) return resumeAcknowledged(requestId)
        // A session this ack does not match may be a replay that has not saved
        // its next reply yet; the caller will not ask again, so wait for it.
        return Effect.flatten(awaitStoredReply(requestId, session))
      })
    )

  const interrupt = (storageRequestId: string, clientRequestId = storageRequestId): Effect.Effect<void> =>
    Effect.suspend(() => {
      const waiters = workerWaiters.get(storageRequestId)
      if (waiters !== undefined) {
        const remaining = waiters.filter((waiter) => {
          if (waiter.clientRequestId !== clientRequestId) return true
          Deferred.doneUnsafe(waiter.deferred, Effect.die(new Error("Delayed entity request interrupted")))
          return false
        })
        if (remaining.length === 0) workerWaiters.delete(storageRequestId)
        else workerWaiters.set(storageRequestId, remaining)
      }
      const session = sessions.get(storageRequestId)
      if (session === undefined || session.uninterruptible) return Effect.void
      // Keep ownership through handler finalization and the terminal write.
      // A failed write must leave the row owned rather than replayable.
      session.cancelling = true
      if (session.ack !== undefined) {
        Deferred.doneUnsafe(session.ack.deferred, Effect.void)
        session.ack = undefined
      }
      Queue.endUnsafe(session.queue)
      const stop = session.fiber === undefined ? Effect.void : Effect.asVoid(Fiber.interrupt(session.fiber))
      // The handler finalizer takes this same permit. Interrupt outside it.
      return Effect.andThen(
        stop,
        Semaphore.withPermit(
          semaphore,
          Effect.andThen(
            session.completeInterrupt,
            Effect.suspend(() => {
              if (sessions.get(storageRequestId) === session) sessions.delete(storageRequestId)
              return inFlightPersisted === 0 ? rearm : Effect.void
            })
          )
        )
      )
    })

  const reset = (requestId: string): Effect.Effect<void> => write(clearReplies(sql, requestId))

  const alarm = Effect.suspend(() => {
    const registration = getEntityRegistration(options.address.entityType)
    if (registration === undefined) {
      // A deploy that removed this entity type leaves its last alarm behind:
      // it fails here, Cloudflare retries it 6 times, and the chain stops. The
      // `cluster_entity_state` row is never cleaned up.
      return Effect.die(`No handlers registered for entity type: ${options.address.entityType}`)
    }
    // The entry permit covers replay setup and alarm arming. The next alarm is
    // armed before awaiting the replayed handlers: a handler that outlives the
    // alarm wall-clock limit kills this invocation, and the chain must not
    // depend on code after it.
    return Effect.flatten(Semaphore.withPermit(
      semaphore,
      Effect.gen(function*() {
        const rows = (yield* loadUnprocessed(sql)).filter((row) => !isRunning(row.requestId))
        const keepAlive = loadEntityState(sql).keepAlive
        // A heartbeat left over after keep-alive was released must not
        // rebuild the entity; the `ensuring` below still settles the alarm.
        if (rows.length === 0 && !keepAlive) return Effect.void
        const entityRuntime = yield* getRuntime(registration)
        const fibers = yield* replayRows(registration, entityRuntime, rows)
        yield* rearm
        const awaitReplays = Effect.asVoid(Fiber.awaitAll(fibers))
        if (!keepAlive) return awaitReplays
        // The hold is never awaited: it does not resolve while held.
        return Effect.andThen(
          Effect.catchCause(entityRuntime.warm, (cause) => Effect.logError("Entity keep-alive rebuild failed", cause)),
          awaitReplays
        )
      })
    )).pipe(
      Effect.ensuring(Semaphore.withPermit(semaphore, rearm)),
      Effect.withSpan("CloudflareCluster.alarm", {
        attributes: {
          entityType: registration.entity.type,
          entityId: String(options.address.entityId)
        }
      }, { captureStackTrace: false }),
      Effect.provideContext(registration.context)
    )
  })

  const saveKeepAliveState = (wanted: boolean): Effect.Effect<void> =>
    Semaphore.withPermit(
      semaphore,
      Effect.andThen(
        write(saveKeepAlive(sql, wanted)),
        wanted ? armHeartbeat : rearm
      )
    )

  const deliverReply = (requestId: string, reply: string): Effect.Effect<boolean> =>
    Effect.sync(() => replyRegistry.deliver(requestId, reply))

  return { invoke, acknowledge, interrupt, reset, alarm, deliverReply, saveKeepAlive: saveKeepAliveState }
}
