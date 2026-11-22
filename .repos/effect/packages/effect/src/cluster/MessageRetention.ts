/**
 * Deletes a persisted cluster entity's completed requests from message storage
 * once they are older than a retention.
 *
 * Persisted entities keep every request and its replies in `MessageStorage` to
 * answer duplicates and resume interrupted work, so without a retention their
 * storage grows without bound.
 *
 * @stability unstable
 * @since 4.1.3
 */
import * as Clock from "../Clock.ts"
import * as Duration from "../Duration.ts"
import * as Effect from "../Effect.ts"
import type * as Layer from "../Layer.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import type { Entity } from "./Entity.ts"
import { MessageStorage } from "./MessageStorage.ts"
import type { Sharding } from "./Sharding.ts"
import * as Singleton from "./Singleton.ts"

const batchSize = 1000

/**
 * Creates a layer that registers a singleton deleting the entity's completed
 * requests once they are older than `retention`.
 *
 * **When to use**
 *
 * Use when a long-lived persisted entity would otherwise keep one stored
 * request and reply for every message it has ever handled.
 *
 * **Details**
 *
 * Every `interval` (default 1 minute), the singleton deletes in batches each
 * request of the entity type whose final reply is older than `retention`, with
 * its acknowledgements, interrupts and replies. Running requests and requests
 * reset with `MessageStorage.clearReplies` are kept. Failures are logged and
 * retried on the next interval.
 *
 * The singleton runs in `shardGroup` (default `"default"`), not the entity's
 * shard group.
 *
 * **Gotchas**
 *
 * - A request sent again with the same primary key after deletion runs the
 *   handler again.
 * - Choose a retention longer than any client retry window or reader of the
 *   stored replies.
 * - Do not use it for workflow or `ClusterCron` entities, which rely on stored
 *   replies to know what already ran.
 * - Include the layer on every runner that can be assigned `shardGroup`, so it
 *   keeps running when shards move.
 * - SQL storage on MySQL needs MySQL 8.0.1+ or MariaDB 10.6+, and
 *   `binlog_format` `ROW` or `MIXED`. Otherwise every cleanup fails and is
 *   logged.
 *
 * **Example** (Forgetting a week-old request)
 *
 * ```ts
 * import { Effect, Layer, Schema } from "effect"
 * import { ClusterSchema, Entity, MessageRetention } from "effect/cluster"
 * import { Rpc } from "effect/rpc"
 *
 * const Counter = Entity.make("Counter", [
 *   Rpc.make("Hit", {
 *     payload: { id: Schema.String },
 *     primaryKey: ({ id }) => id
 *   })
 * ]).annotateRpcs(ClusterSchema.Persisted, true)
 *
 * export const CounterLive = Layer.mergeAll(
 *   Counter.toLayer({ Hit: () => Effect.void }),
 *   MessageRetention.make({ entity: Counter, retention: "7 days" })
 * )
 * ```
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.3
 */
export const make = <Type extends string, Rpcs extends Rpc.Any>(options: {
  readonly entity: Entity<Type, Rpcs>
  readonly retention: Duration.Input
  readonly interval?: Duration.Input | undefined
  readonly shardGroup?: string | undefined
}): Layer.Layer<never, never, Sharding | MessageStorage> => {
  const entityType = options.entity.type
  const retention = Duration.toMillis(options.retention)
  const interval = options.interval ?? Duration.minutes(1)
  return Singleton.make(
    `effect/cluster/MessageRetention/${entityType}`,
    Effect.gen(function*() {
      const storage = yield* MessageStorage
      while (true) {
        yield* Effect.sleep(interval)
        const completedBefore = (yield* Clock.currentTimeMillis) - retention
        yield* storage.deleteProcessed({ entityType, completedBefore, limit: batchSize }).pipe(
          Effect.repeat({ while: (deleted) => deleted >= batchSize }),
          Effect.catchCause((cause) => Effect.logWarning("Message retention failed", cause))
        )
      }
    }).pipe(
      Effect.annotateLogs({
        module: "effect/cluster/MessageRetention",
        entityType
      })
    ),
    { shardGroup: options.shardGroup }
  )
}
