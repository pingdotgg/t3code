import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface GetRecordsRequest extends Omit<
  Kinesis.GetRecordsInput,
  "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:GetRecords`.
 *
 * Bind this operation to a `Stream` to read records from a shard using an
 * iterator obtained via `AWS.Kinesis.GetShardIterator`. Provide the
 * implementation with `Effect.provide(AWS.Kinesis.GetRecordsHttp)`. For
 * push-based processing, prefer `consumeStreamRecords` (a Lambda event
 * source) over manual polling.
 * @binding
 * @section Reading Records
 * @example Read Records from a Shard
 * ```typescript
 * // init — bind the operations to the stream
 * const getShardIterator = yield* AWS.Kinesis.GetShardIterator(stream);
 * const getRecords = yield* AWS.Kinesis.GetRecords(stream);
 *
 * // runtime — obtain an iterator, then read
 * const iterator = yield* getShardIterator({
 *   ShardId: shardId,
 *   ShardIteratorType: "TRIM_HORIZON",
 * });
 * const result = yield* getRecords({
 *   ShardIterator: iterator.ShardIterator!,
 * });
 * for (const record of result.Records ?? []) {
 *   yield* Effect.log(record.PartitionKey);
 * }
 * ```
 */
export interface GetRecords extends Binding.Service<
  GetRecords,
  "AWS.Kinesis.GetRecords",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: GetRecordsRequest,
    ) => Effect.Effect<Kinesis.GetRecordsOutput, Kinesis.GetRecordsError>
  >
> {}

export const GetRecords = Binding.Service<GetRecords>("AWS.Kinesis.GetRecords");
