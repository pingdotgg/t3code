import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export interface SubscribeToShardRequest extends Omit<
  Kinesis.SubscribeToShardInput,
  "ConsumerARN"
> {}

/**
 * Runtime binding for `kinesis:SubscribeToShard` (enhanced fan-out).
 *
 * Bind this operation to a `StreamConsumer` (a registered enhanced fan-out
 * consumer) to open a push-based subscription to a shard — the consumer ARN
 * is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.Kinesis.SubscribeToShardHttp)`.
 * @binding
 * @section Enhanced Fan-Out
 * @example Subscribe to a Shard
 * ```typescript
 * const consumer = yield* AWS.Kinesis.StreamConsumer("Analytics", {
 *   streamArn: stream.streamArn,
 * });
 * // init — bind the operation to the registered consumer
 * const subscribeToShard = yield* AWS.Kinesis.SubscribeToShard(consumer);
 *
 * // runtime — open the subscription
 * const result = yield* subscribeToShard({
 *   ShardId: shardId,
 *   StartingPosition: { Type: "LATEST" },
 * });
 * // result.EventStream delivers records for up to 5 minutes
 * ```
 */
export interface SubscribeToShard extends Binding.Service<
  SubscribeToShard,
  "AWS.Kinesis.SubscribeToShard",
  (
    consumer: StreamConsumer,
  ) => Effect.Effect<
    (
      request: SubscribeToShardRequest,
    ) => Effect.Effect<
      Kinesis.SubscribeToShardOutput,
      Kinesis.SubscribeToShardError
    >
  >
> {}

export const SubscribeToShard = Binding.Service<SubscribeToShard>(
  "AWS.Kinesis.SubscribeToShard",
);
