import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface ListShardsRequest extends Omit<
  Kinesis.ListShardsInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:ListShards`.
 *
 * Bind this operation to a `Stream` to enumerate its shards — typically the
 * first step before obtaining a shard iterator and reading records. Provide
 * the implementation with `Effect.provide(AWS.Kinesis.ListShardsHttp)`.
 * @binding
 * @section Inspecting Streams
 * @example List the Stream's Shards
 * ```typescript
 * // init
 * const listShards = yield* AWS.Kinesis.ListShards(stream);
 *
 * // runtime
 * const result = yield* listShards();
 * const shardIds = (result.Shards ?? []).map((shard) => shard.ShardId);
 * ```
 */
export interface ListShards extends Binding.Service<
  ListShards,
  "AWS.Kinesis.ListShards",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: ListShardsRequest,
    ) => Effect.Effect<Kinesis.ListShardsOutput, Kinesis.ListShardsError>
  >
> {}

export const ListShards = Binding.Service<ListShards>("AWS.Kinesis.ListShards");
