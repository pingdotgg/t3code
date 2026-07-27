import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetShardIteratorRequest extends Omit<
  Kinesis.GetShardIteratorInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:GetShardIterator`.
 *
 * Bind this operation to a `Stream` to obtain a shard iterator — the starting
 * position for reading records with `AWS.Kinesis.GetRecords`. The stream name
 * is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.Kinesis.GetShardIteratorHttp)`.
 * @binding
 * @section Reading Records
 * @example Obtain an Iterator for the Latest Position
 * ```typescript
 * // init
 * const getShardIterator = yield* AWS.Kinesis.GetShardIterator(stream);
 *
 * // runtime
 * const iterator = yield* getShardIterator({
 *   ShardId: shardId,
 *   ShardIteratorType: "LATEST",
 * });
 * // pass iterator.ShardIterator to getRecords
 * ```
 */
export interface GetShardIterator extends Binding.Service<
  GetShardIterator,
  "AWS.Kinesis.GetShardIterator",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: GetShardIteratorRequest,
    ) => Effect.Effect<
      Kinesis.GetShardIteratorOutput,
      Kinesis.GetShardIteratorError
    >
  >
> {}

export const GetShardIterator = Binding.Service<GetShardIterator>(
  "AWS.Kinesis.GetShardIterator",
);
