import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface MergeShardsRequest extends Omit<
  Kinesis.MergeShardsInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:MergeShards`.
 *
 * Bind this operation to a `Stream` to merge two adjacent shards of a
 * PROVISIONED-mode stream into one — the stream ARN is injected
 * automatically. Useful for building custom shard-scaling logic (the
 * `Stream` resource's `shardCount` prop covers uniform scaling via
 * `UpdateShardCount`; merge/split give per-shard control). Provide the
 * implementation with `Effect.provide(AWS.Kinesis.MergeShardsHttp)`.
 * @binding
 * @section Managing Shards
 * @example Merge Two Adjacent Shards
 * ```typescript
 * // init — bind the operation to the stream
 * const mergeShards = yield* AWS.Kinesis.MergeShards(stream);
 *
 * // runtime — merge a shard with its adjacent neighbor
 * yield* mergeShards({
 *   ShardToMerge: "shardId-000000000000",
 *   AdjacentShardToMerge: "shardId-000000000001",
 * });
 * ```
 */
export interface MergeShards extends Binding.Service<
  MergeShards,
  "AWS.Kinesis.MergeShards",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: MergeShardsRequest,
    ) => Effect.Effect<Kinesis.MergeShardsResponse, Kinesis.MergeShardsError>
  >
> {}

export const MergeShards = Binding.Service<MergeShards>(
  "AWS.Kinesis.MergeShards",
);
