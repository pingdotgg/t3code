/**
 * Runs Effect Cluster entities on Cloudflare Durable Objects.
 *
 * On this path every entity instance is one Durable Object: the Worker encodes
 * an `(entityType, entityId)` address into a Durable Object name, resolves the
 * object stub with `getByName`, and the object's SQLite storage is the system
 * of record. There is no shard routing, no runner fleet, and no external
 * message storage; `layer` provides the cluster `Sharding` service on top of
 * the Durable Object namespace bindings instead of `Sharding.layer`.
 *
 * @stability experimental
 * @since 4.1.3
 */
import * as Cause from "effect/Cause"
import { Clock } from "effect/Clock"
import { MailboxFull, PersistenceError } from "effect/cluster/ClusterError"
import { isUninterruptibleForClient, Persisted, Uninterruptible } from "effect/cluster/ClusterSchema"
import * as DeliverAt from "effect/cluster/DeliverAt"
import type * as Entity from "effect/cluster/Entity"
import * as EntityAddress from "effect/cluster/EntityAddress"
import * as EntityId from "effect/cluster/EntityId"
import * as Envelope from "effect/cluster/Envelope"
import * as ShardId from "effect/cluster/ShardId"
import { Sharding } from "effect/cluster/Sharding"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { PersistedQueueFactory } from "effect/persistence/PersistedQueue"
import type * as Rpc from "effect/rpc/Rpc"
import * as RpcClient from "effect/rpc/RpcClient"
import { type FromClient, RequestId } from "effect/rpc/RpcMessage"
import * as RpcSchema from "effect/rpc/RpcSchema"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import type * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine"
import * as CloudflarePersistedQueue from "./CloudflarePersistedQueue.ts"
import * as CloudflareWorkflowEngine from "./CloudflareWorkflowEngine.ts"
import { setWithEviction } from "./internal/boundedMap.ts"
import * as Internal from "./internal/clusterName.ts"
import {
  defaultKeepAliveHeartbeatMillis,
  registerEntity as registerEntityHandler,
  unregisterEntity
} from "./internal/entityRegistry.ts"
import { CurrentEntityName, CurrentReplyRegistry } from "./internal/entityReply.ts"
import { decodeInvokeResult, decodeReplyFor, encodeRequest } from "./internal/entityWire.ts"
import { registerSingleton as registerSingletonHandler, unregisterSingleton } from "./internal/singletonRegistry.ts"
import { boundedRetry, callDurableObject } from "./internal/transport.ts"

/**
 * A Durable Object name decoded back into its entity address parts.
 *
 * @stability experimental
 * @category models
 * @since 4.1.3
 */
export interface ClusterName {
  readonly type: string
  readonly id: string
}

/**
 * Encodes an entity address into the Durable Object name used with
 * `getByName`.
 *
 * **Details**
 *
 * The name is the entity type length-prefixed as `` `${type.length}:${type}${id}` ``,
 * which keeps `(type, id)` pairs collision-free without restricting the
 * characters an entity id may contain. Workflow, queue, and singleton names use
 * the same scheme on their own namespaces.
 *
 * @stability experimental
 * @category encoding
 * @since 4.1.3
 */
export const encodeName: (type: string, id: string) => string = Internal.encodeName

/**
 * Decodes a Durable Object name produced by {@link encodeName} back into its
 * entity address parts.
 *
 * **Details**
 *
 * Returns `undefined` for names that were not produced by {@link encodeName},
 * including non-canonical length prefixes. A Durable Object uses this to
 * recover its own address from `ctx.id.name`.
 *
 * @stability experimental
 * @category decoding
 * @since 4.1.3
 */
export const decodeName: (name: string) => ClusterName | undefined = Internal.decodeName

/**
 * Returns the singleton name of the seed singleton that `ClusterCron.make`
 * registers for the cron job with the given name.
 *
 * **When to use**
 *
 * Use to wake a `ClusterCron` from a Worker Cron Trigger, by passing the
 * result to `cluster.wake` with Alchemy or by prefixing it with `Singleton/`
 * for `getByName` on the singleton namespace with Wrangler.
 *
 * **Details**
 *
 * The result is `"ClusterCron/<name>"`, the singleton name without the
 * `Singleton/` Durable Object name prefix.
 *
 * **Gotchas**
 *
 * A singleton runs only when its Durable Object is woken, so a `ClusterCron`
 * never schedules its first run until a Cron Trigger wakes this singleton.
 * Each later run is scheduled through a destination alarm.
 *
 * @stability experimental
 * @category encoding
 * @since 4.1.3
 */
export const clusterCronSingletonName = (name: string): string => `ClusterCron/${name}`

/**
 * The Durable Object namespace bindings and entity definitions the cluster
 * layer is built from.
 *
 * **Details**
 *
 * `entities` is the complete set of entity definitions the Worker serves.
 * Handlers are attached per entity type with `Entity.toLayer`; a client or
 * handler registration for an entity type outside this set fails at the
 * Worker, before any Durable Object is contacted.
 *
 * `keepAliveHeartbeat` (default 30 seconds) is the interval of the alarm an
 * entity Durable Object keeps armed while it holds `Entity.keepAlive` or runs
 * a persisted request. Cloudflare never re-creates an evicted object on its
 * own, so this alarm is what rebuilds a kept-alive entity and replays an
 * interrupted request after a restart or deploy. It bounds recovery latency;
 * it is not a liveness check.
 *
 * @stability experimental
 * @category layers
 * @since 4.1.3
 */
export interface LayerOptions {
  readonly entities: ReadonlyArray<Entity.Entity<any, any>>
  readonly entityNamespace: DurableObjectNamespace
  readonly workflowNamespace: DurableObjectNamespace
  readonly queueNamespace: DurableObjectNamespace
  readonly singletonNamespace: DurableObjectNamespace
  readonly keepAliveHeartbeat?: Duration.Input | undefined
}

const notImplemented = (method: string) =>
  Effect.die(
    new Error(`CloudflareCluster: ${method} is not implemented yet on the Cloudflare Durable Object path`)
  )

const notSupported = (method: string) =>
  Effect.die(new Error(`CloudflareCluster: ${method} is not supported on the Cloudflare Durable Object path`))

interface EntityStub {
  readonly invoke: (envelope: string, discard: boolean, delivery?: {
    readonly deliverAt?: number | undefined
    readonly primaryKey?: string | null | undefined
    readonly replyTo?: string | undefined
  }) => Promise<unknown>
  readonly acknowledge: (requestId: string, replyId: string) => Promise<ReadonlyArray<string>>
  readonly interrupt: (storageRequestId: string, clientRequestId?: string) => Promise<void>
  readonly reset: (requestId: string) => Promise<void>
}

interface ClientTargetValue {
  readonly address: EntityAddress.EntityAddress
  // A stub that threw must not be reused, so every call resolves a fresh one.
  readonly resolve: () => EntityStub
}

class ClientTarget extends Context.Service<ClientTarget, ClientTargetValue>()(
  "@effect/platform-cloudflare/CloudflareCluster/ClientTarget"
) {}

const uuidV7 = (timestamp: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0] = Math.floor(timestamp / 2 ** 40)
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff
  bytes[5] = timestamp & 0xff
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = (byte: number) => byte.toString(16).padStart(2, "0")
  return [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10)]
    .map((part) => Array.from(part, hex).join(""))
    .join("-")
}

const requestTargetCapacity = 4096

// ClusterCron owns this entity inside its layer, so callers cannot include it
// in LayerOptions.entities. Its reserved shape is the only implicit entity.
const isClusterCronEntity = (entity: Entity.Entity<any, any>): boolean => {
  if (!entity.type.startsWith("ClusterCron/") || entity.protocol.requests.size !== 2) return false
  const run = entity.protocol.requests.get("run")
  const start = entity.protocol.requests.get("start")
  return run !== undefined && start !== undefined &&
    Context.get(run.annotations, Persisted) &&
    Context.get(run.annotations, Uninterruptible) === true &&
    Context.get(start.annotations, Persisted)
}

const make = Effect.fnUntraced(function*(options: LayerOptions) {
  const layerScope = yield* Effect.scope
  const layerContext = yield* Effect.context<never>()
  const entities = new Map<string, Entity.Entity<any, any>>()
  for (const entity of options.entities) {
    entities.set(entity.type, entity)
  }
  const clock = yield* Clock
  const keepAliveHeartbeat = Duration.toMillis(options.keepAliveHeartbeat ?? defaultKeepAliveHeartbeatMillis)
  const requestTargets = new Map<string, { readonly resolve: () => EntityStub; storageRequestId: string }>()

  const unknownEntity = (entity: Entity.Entity<any, any>) =>
    Effect.die(
      new Error(
        `CloudflareCluster: entity type "${entity.type}" is not part of the entities bound at Worker init`
      )
    )

  const buildClient = Effect.fnUntraced(function*(entity: Entity.Entity<any, any>) {
    type ClientEntry = {
      readonly rpc: Rpc.AnyWithProps
      readonly context: Context.Context<never>
      readonly clientRequestId: string
      storageRequestId: string
      lastChunkId?: string
    }
    const entries = new Map<string, ClientEntry>()

    // `handleFromClient` is hoisted and only invoked once requests are made,
    // after `client` is constructed.
    const client = yield* RpcClient.makeNoSerialization<any, MailboxFull | PersistenceError, true>(entity.protocol, {
      spanPrefix: `${entity.type}.client`,
      supportsAck: true,
      generateRequestId: () => RequestId(uuidV7(clock.currentTimeMillisUnsafe())),
      flatten: true,
      onFromClient: (options) => handleFromClient(options)
    })

    const deliverReplies = (entry: ClientEntry, replyTexts: ReadonlyArray<string>): Effect.Effect<void> =>
      Effect.forEach(
        replyTexts,
        (replyText) =>
          Effect.flatMap(decodeReplyFor(entry.rpc, entry.context, replyText), (reply) => {
            if (reply._tag === "Chunk") {
              entry.lastChunkId = String(reply.id)
              return client.write({
                _tag: "Chunk",
                clientId: 0,
                requestId: RequestId(entry.clientRequestId),
                values: reply.values
              })
            }
            entries.delete(entry.clientRequestId)
            return client.write({
              _tag: "Exit",
              clientId: 0,
              requestId: RequestId(entry.clientRequestId),
              exit: reply.exit
            })
          }),
        { discard: true }
      )

    function handleFromClient({ context, message }: {
      readonly message: FromClient<any>
      readonly context: Context.Context<never>
    }): Effect.Effect<void, MailboxFull | PersistenceError> {
      const target = Context.getUnsafe(context, ClientTarget)
      switch (message._tag) {
        case "Request": {
          const discard = message.discard === true
          const rpc = entity.protocol.requests.get(message.tag)! as Rpc.AnyWithProps
          const clientRequestId = String(message.id)
          const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(rpc.payloadSchema))(message.payload).pipe(
            Effect.provideContext(context as any),
            Effect.orDie
          ) as unknown as Effect.Effect<unknown>
          return Effect.flatMap(encode, (payload) => {
            const envelope = encodeRequest({
              requestId: clientRequestId,
              address: target.address,
              tag: message.tag,
              payload,
              headers: message.headers,
              ...(message.traceId === undefined ? undefined : {
                traceId: message.traceId,
                spanId: message.spanId,
                sampled: message.sampled
              })
            })
            const entry: ClientEntry = {
              rpc,
              context,
              clientRequestId,
              storageRequestId: clientRequestId
            }
            if (!discard) entries.set(clientRequestId, entry)
            const deliverAt = DeliverAt.toMillis(message.payload)
            const delayed = deliverAt !== null && deliverAt > clock.currentTimeMillisUnsafe()
            const persisted = Context.get(rpc.annotations, Persisted)
            const primaryKey = Envelope.primaryKey({
              ...message,
              requestId: message.id,
              address: target.address,
              headers: message.headers
            } as any)
            const replyTo = discard ? undefined : Option.getOrUndefined(Context.getOption(context, CurrentEntityName))
            const replyRegistry = discard
              ? undefined
              : Option.getOrUndefined(Context.getOption(context, CurrentReplyRegistry))
            if (delayed && (!persisted || (!discard && primaryKey === null))) {
              entries.delete(clientRequestId)
              return Effect.fail(
                new PersistenceError({
                  cause: new Error(
                    !persisted
                      ? "Future DeliverAt requests must be persisted"
                      : "Future DeliverAt asks must define a PrimaryKey"
                  )
                })
              )
            }
            if (delayed && RpcSchema.isStreamSchema(rpc.successSchema)) {
              entries.delete(clientRequestId)
              return Effect.fail(
                new PersistenceError({
                  cause: new Error("Stream asks with a future DeliverAt are not supported")
                })
              )
            }
            const delivery = delayed
              ? { deliverAt: deliverAt!, primaryKey, ...(replyTo === undefined ? undefined : { replyTo }) }
              : replyTo === undefined
              ? undefined
              : { replyTo }
            // A pinned caller receives the scheduled reply pushed over its own
            // Durable Object's `deliverReply` RPC, which completes this waiter.
            // The destination stores this request id with the reply target and
            // pushes under it, so registering before the send closes the race.
            const pushedReply = delivery?.replyTo !== undefined && replyRegistry !== undefined
              ? Deferred.makeUnsafe<string>()
              : undefined
            if (pushedReply !== undefined) replyRegistry!.register(clientRequestId, pushedReply)
            // The mailbox dedupes on the request id, so a persisted request is
            // safe to retry. A non-persisted one may already be running.
            const send = callDurableObject({
              resolve: target.resolve,
              call: (stub) => stub.invoke(envelope, discard, delivery),
              retry: persisted ? boundedRetry : undefined
            }).pipe(
              Effect.flatMap(decodeInvokeResult),
              Effect.flatMap((result): Effect.Effect<void, MailboxFull | PersistenceError> => {
                switch (result._tag) {
                  case "MailboxFull":
                    return Effect.fail(new MailboxFull({ address: target.address }))
                  case "EncodedMessageTooLarge":
                    return Effect.fail(
                      new PersistenceError({ cause: new Error("Encoded entity message exceeds 2 MB") })
                    )
                  case "AskDeduplicatedToTell":
                    return Effect.fail(
                      new PersistenceError({
                        cause: new Error("Cannot deduplicate an ask onto a tell with the same PrimaryKey")
                      })
                    )
                  case "Success": {
                    entry.storageRequestId = result.requestId
                    if (!discard && persisted) {
                      setWithEviction(requestTargets, clientRequestId, {
                        resolve: target.resolve,
                        storageRequestId: result.requestId
                      }, requestTargetCapacity)
                    }
                    // A discarded call is acknowledged once its message is delivered.
                    if (discard) {
                      return client.write({
                        _tag: "Exit",
                        clientId: 0,
                        requestId: RequestId(clientRequestId),
                        exit: Exit.void as any
                      })
                    }
                    if (pushedReply !== undefined && result.replies.length === 0) {
                      return Effect.flatMap(
                        Deferred.await(pushedReply),
                        (replyText) => deliverReplies(entry, [replyText])
                      )
                    }
                    return deliverReplies(entry, result.replies)
                  }
                }
              }),
              // A failed send gets no `Exit` reply, so release its entry here.
              // An interrupt releases it in the `Interrupt` case instead, which
              // still needs it to reach the Durable Object.
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? Effect.sync(() => entries.delete(clientRequestId))
                  : Effect.void
              )
            )
            return pushedReply === undefined ? send : Effect.ensuring(
              send,
              Effect.sync(() => replyRegistry!.unregister(clientRequestId, pushedReply))
            )
          })
        }
        case "Ack": {
          const entry = entries.get(String(message.requestId))
          if (entry === undefined || entry.lastChunkId === undefined) return Effect.void
          const lastChunkId = entry.lastChunkId
          return callDurableObject({
            resolve: target.resolve,
            call: (stub) => stub.acknowledge(entry.storageRequestId, lastChunkId),
            retry: boundedRetry
          }).pipe(
            Effect.flatMap((replies) => deliverReplies(entry, replies))
          )
        }
        case "Interrupt": {
          const clientRequestId = String(message.requestId)
          const entry = entries.get(clientRequestId)
          entries.delete(clientRequestId)
          requestTargets.delete(clientRequestId)
          if (entry === undefined) return Effect.void
          if (isUninterruptibleForClient(entry.rpc.annotations)) return Effect.void
          return callDurableObject({
            resolve: target.resolve,
            call: (stub) => stub.interrupt(entry.storageRequestId, clientRequestId),
            retry: boundedRetry
          })
        }
        default:
          return Effect.void
      }
    }

    return (entityId: string) => {
      const id = EntityId.make(entityId)
      const name = Internal.encodeName(entity.type, entityId)
      const target = ClientTarget.context({
        address: EntityAddress.make({
          shardId: ShardId.make(entity.getShardGroup(id), 1),
          entityId: id,
          entityType: entity.type
        }),
        resolve: () => options.entityNamespace.getByName(name) as unknown as EntityStub
      })
      const result: Record<string, unknown> = {}
      for (const tag of entity.protocol.requests.keys()) {
        const rpc = entity.protocol.requests.get(tag)! as Rpc.AnyWithProps
        const isStream = RpcSchema.isStreamSchema(rpc.successSchema)
        const contextFor = (
          ambient: Context.Context<never>,
          methodOptions?: { readonly context?: Context.Context<never> }
        ) => {
          const currentEntityName = Option.getOrUndefined(Context.getOption(ambient, CurrentEntityName))
          const replyRegistry = Option.getOrUndefined(Context.getOption(ambient, CurrentReplyRegistry))
          let requestContext = currentEntityName === undefined
            ? target
            : Context.add(target, CurrentEntityName, currentEntityName)
          if (replyRegistry !== undefined) {
            requestContext = Context.add(requestContext, CurrentReplyRegistry, replyRegistry)
          }
          if (methodOptions?.context !== undefined) {
            requestContext = Context.merge(methodOptions.context, requestContext)
          }
          return requestContext
        }
        result[tag] = (payload: unknown, methodOptions?: {
          readonly context?: Context.Context<never>
          readonly asQueue?: boolean
        }) => {
          // The caller's context is read when the request runs, so it carries
          // the calling entity's reply target. The untyped protocol erases
          // the stream/queue return shape, hence `any`.
          const call = (ambient: Context.Context<never>): any =>
            client.client(tag, payload, { ...methodOptions, context: contextFor(ambient, methodOptions) })
          // With `asQueue`, a stream RPC yields its Dequeue as an Effect.
          return isStream && methodOptions?.asQueue !== true
            ? Stream.unwrap(Effect.map(Effect.context<never>(), call))
            : Effect.contextWith(call)
        }
      }
      return result as any
    }
  })

  type ClientFactory = (entityId: string) => any
  // Like `Sharding`, each entity's base client is built once from the layer
  // context and scope, so it needs no caller Scope, outlives the scope it was
  // first requested in, and resolves client middleware from the layer rather
  // than from whichever caller asked first.
  const clientContext = Context.add(layerContext, Scope.Scope, layerScope)
  const clients = new Map<Entity.Entity<any, any>, Deferred.Deferred<ClientFactory>>()
  const makeClient = (entity: Entity.Entity<any, any>): Effect.Effect<ClientFactory> =>
    Effect.suspend(() => {
      if (!entities.has(entity.type)) return unknownEntity(entity)
      const existing = clients.get(entity)
      if (existing !== undefined) return Deferred.await(existing)
      const deferred = Deferred.makeUnsafe<ClientFactory>()
      clients.set(entity, deferred)
      return buildClient(entity).pipe(
        Effect.provideContext(clientContext),
        Effect.tap((factory) => Deferred.succeed(deferred, factory)),
        Effect.uninterruptible
      )
    })

  const registerEntity = Effect.fnUntraced(function*(
    entity: Entity.Entity<any, any>,
    build: Effect.Effect<unknown, never, unknown>,
    buildOptions?: Record<string, unknown>
  ) {
    const declared = entities.has(entity.type)
    if (!declared && !isClusterCronEntity(entity)) {
      return yield* unknownEntity(entity)
    }
    const context = yield* Effect.context<never>()
    const registration = { entity, build: build as any, options: buildOptions, context, keepAliveHeartbeat }
    if (!registerEntityHandler(entity.type, registration)) return
    if (!declared) entities.set(entity.type, entity)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregisterEntity(entity.type, registration)
        if (!declared && entities.get(entity.type) === entity) entities.delete(entity.type)
      })
    )
  })

  const registerSingleton = Effect.fnUntraced(function*(
    name: string,
    run: Effect.Effect<void, unknown, unknown>
  ) {
    // Fails fast at registration when the singleton namespace binding is
    // missing, before any Cron Trigger fires.
    options.singletonNamespace.getByName(`Singleton/${name}`)
    const context = yield* Effect.context<never>()
    const registration = {
      run: run as Effect.Effect<void, unknown, never>,
      context
    }
    if (!registerSingletonHandler(name, registration)) {
      return yield* Effect.die(`Singleton '${name}' is already registered`)
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregisterSingleton(name, registration)
      })
    )
  })

  return Sharding.of({
    getRegistrationEvents: Stream.never,
    getShardId: (_entityId, group) => ShardId.make(group, 1),
    hasShardId: () => true,
    // A Snowflake needs a machine id unique across the fleet, which isolates
    // do not have.
    getSnowflake: notSupported("Sharding.getSnowflake"),
    isShutdown: Effect.succeed(false),
    makeClient: makeClient as Sharding["Service"]["makeClient"],
    registerEntity: registerEntity as Sharding["Service"]["registerEntity"],
    registerSingleton: registerSingleton as Sharding["Service"]["registerSingleton"],
    send: () => notImplemented("Sharding.send"),
    sendOutgoing: () => notImplemented("Sharding.sendOutgoing"),
    notify: () => notImplemented("Sharding.notify"),
    reset: (requestId) => {
      const target = requestTargets.get(String(requestId))
      if (target === undefined) return Effect.succeed(false)
      return callDurableObject({
        resolve: target.resolve,
        call: (stub) => stub.reset(target.storageRequestId),
        retry: boundedRetry
      }).pipe(Effect.orDie, Effect.as(true))
    },
    pollStorage: notImplemented("Sharding.pollStorage"),
    activeEntityCount: Effect.succeed(0)
  })
})

/**
 * Builds the cluster on Cloudflare Durable Objects.
 *
 * **Details**
 *
 * Provides the cluster `Sharding` service on top of the four same-Worker
 * Durable Object namespace bindings, plus the `WorkflowEngine` backed by the
 * workflow class and the `PersistedQueueFactory` backed by the queue class, so
 * the `DurableQueue` user API works out of the box. `Entity.client` resolves
 * an entity to its Durable Object by
 * encoding `(type, id)` with {@link encodeName} and calling `getByName`; an
 * unknown entity type or a bad encode fails at the Worker before any Durable
 * Object is contacted. Entity handlers registered with `Entity.toLayer` are
 * recorded per `EntityType` at Worker init and built once per Durable Object
 * wake; workflow handlers registered with `Workflow.toLayer` follow the same
 * pattern on the workflow class.
 *
 * @stability experimental
 * @category layers
 * @since 4.1.3
 */
export const layer = (
  options: LayerOptions
): Layer.Layer<Sharding | WorkflowEngine | PersistedQueueFactory> =>
  Layer.mergeAll(
    Layer.effect(Sharding, make(options)),
    CloudflareWorkflowEngine.layer({ workflowNamespace: options.workflowNamespace }),
    CloudflarePersistedQueue.layer({ queueNamespace: options.queueNamespace })
  )

/**
 * An `SqlClient` on the current entity Durable Object's own SQLite storage.
 *
 * **When to use**
 *
 * Use to keep rows next to the entity's mailbox from an entity handler build
 * or handler, such as state that must survive eviction and commit atomically
 * with each step. Register the handlers with `Entity.toLayer` and read the
 * client with {@link DurableObjectSqlClient.orDie} in the build.
 *
 * **Details**
 *
 * Each entity Durable Object provides this service, an `@effect/sql-sqlite-do`
 * client, to its handler build and handlers, including handlers registered
 * with `Entity.toLayerQueue`. Yielding the tag directly leaves it as a layer
 * requirement; `orDie` has none. It is a separate tag, so any
 * `SqlClient` from the Worker layer (a D1 database, say) stays reachable inside
 * the handlers. To run code written against `SqlClient.SqlClient`, provide this
 * client as that service locally.
 *
 * `withTransaction` uses the object's storage transaction, so several rows
 * commit or roll back together. Rows live and die with the entity's Durable
 * Object and cannot be queried from outside it.
 *
 * **Gotchas**
 *
 * - Outside an entity Durable Object, `orDie` dies on the first handler build.
 *   In tests, provide this service from any SQL layer.
 * - Table names starting with `cluster_` are reserved for the entity mailbox.
 * - A row, like an encoded message, cannot exceed 2 MB.
 * - A storage transaction closes the Durable Object's input gate until it
 *   finishes, so timers and I/O awaited inside `withTransaction` never
 *   resume. Keep transactions to SQL work.
 * - Mailbox writes wait for an open transaction to finish, so a rollback never
 *   takes another handler's stored reply with it.
 *
 * **Example** (Storing rows from entity handlers)
 *
 * ```ts
 * import { CloudflareCluster } from "@effect/platform-cloudflare"
 * import { Effect } from "effect"
 *
 * const JournalLayer = Journal.toLayer(Effect.gen(function*() {
 *   const sql = yield* CloudflareCluster.DurableObjectSqlClient.orDie
 *   yield* sql`CREATE TABLE IF NOT EXISTS journal (entry TEXT NOT NULL)`.pipe(Effect.orDie)
 *   return Journal.of({
 *     Append: ({ payload }) => sql`INSERT INTO journal (entry) VALUES (${payload.entry})`.pipe(Effect.orDie)
 *   })
 * }))
 * ```
 *
 * @stability experimental
 * @category services
 * @since 4.1.3
 */
export class DurableObjectSqlClient extends Context.Service<DurableObjectSqlClient, SqlClient.SqlClient>()(
  "@effect/platform-cloudflare/CloudflareCluster/DurableObjectSqlClient"
) {
  /**
   * Gets the current entity's SQL client, or dies if no client is provided.
   *
   * @stability experimental
   * @since 4.1.3
   */
  static readonly orDie: Effect.Effect<SqlClient.SqlClient> = Effect.flatMap(
    Effect.serviceOption(DurableObjectSqlClient),
    Option.match({
      onNone: () =>
        Effect.die(
          new Error(
            "DurableObjectSqlClient is not available outside an entity Durable Object; provide it from a SQL layer in tests"
          )
        ),
      onSome: Effect.succeed
    })
  )
}
