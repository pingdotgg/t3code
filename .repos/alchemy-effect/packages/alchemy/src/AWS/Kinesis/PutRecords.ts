import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface PutRecordsRequest extends Omit<
  Kinesis.PutRecordsInput,
  "StreamName"
> {}

/**
 * Runtime binding for `kinesis:PutRecords`.
 *
 * Bind this operation to a `Stream` to write up to 500 records per call —
 * the stream name is injected automatically and `kinesis:PutRecords` is
 * granted on the stream. Provide the implementation with
 * `Effect.provide(AWS.Kinesis.PutRecordsHttp)`. For unbounded batching with
 * automatic partial-failure retry, use `AWS.Kinesis.StreamSink` instead.
 * @binding
 * @section Writing Batches
 * @example Put a Batch of Records
 * ```typescript
 * // init — bind the operation to the stream
 * const putRecords = yield* AWS.Kinesis.PutRecords(stream);
 *
 * // runtime — write a batch from a handler
 * const result = yield* putRecords({
 *   Records: orders.map((order) => ({
 *     PartitionKey: order.id,
 *     Data: new TextEncoder().encode(JSON.stringify(order)),
 *   })),
 * });
 * // result.FailedRecordCount > 0 means some entries need re-submission
 * ```
 */
export interface PutRecords extends Binding.Service<
  PutRecords,
  "AWS.Kinesis.PutRecords",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request: PutRecordsRequest,
    ) => Effect.Effect<Kinesis.PutRecordsOutput, Kinesis.PutRecordsError>
  >
> {}

export const PutRecords = Binding.Service<PutRecords>("AWS.Kinesis.PutRecords");
