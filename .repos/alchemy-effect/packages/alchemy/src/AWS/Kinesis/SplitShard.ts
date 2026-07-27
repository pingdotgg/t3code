import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface SplitShardRequest extends Omit<
  Kinesis.SplitShardInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:SplitShard`.
 *
 * Bind this operation to a `Stream` to split one shard of a
 * PROVISIONED-mode stream into two — the stream ARN is injected
 * automatically. Useful for building custom shard-scaling logic that
 * targets a hot shard directly (the `Stream` resource's `shardCount`
 * prop covers uniform scaling via `UpdateShardCount`). Provide the
 * implementation with `Effect.provide(AWS.Kinesis.SplitShardHttp)`.
 * @binding
 * @section Managing Shards
 * @example Split a Hot Shard
 * ```typescript
 * // init — bind the operation to the stream
 * const splitShard = yield* AWS.Kinesis.SplitShard(stream);
 *
 * // runtime — split at the midpoint of the shard's hash-key range
 * yield* splitShard({
 *   ShardToSplit: "shardId-000000000000",
 *   NewStartingHashKey: "170141183460469231731687303715884105728",
 * });
 * ```
 */
export interface SplitShard extends Binding.Service<
  SplitShard,
  "AWS.Kinesis.SplitShard",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: SplitShardRequest,
    ) => Effect.Effect<Kinesis.SplitShardResponse, Kinesis.SplitShardError>
  >
> {}

export const SplitShard = Binding.Service<SplitShard>("AWS.Kinesis.SplitShard");
