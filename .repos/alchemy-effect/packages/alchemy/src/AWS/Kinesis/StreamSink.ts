import type * as Kinesis from "@distilled.cloud/aws/kinesis";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { Stream } from "./Stream.ts";

export type StreamSinkRecord = Kinesis.PutRecordsRequestEntry;

export type StreamSinkError =
  | Kinesis.PutRecordsError
  | BatchRetryExhaustedError<StreamSinkRecord>;

/**
 * A partition-aware sink for batching `PutRecords` requests into a stream
 * (500 records / 5 MiB per call).
 *
 * Each input element is a raw `PutRecordsRequestEntry`, so callers stay in
 * control of `PartitionKey` and optional `ExplicitHashKey`.
 *
 * Records the API reports as failed (`FailedRecordCount > 0`, per-record
 * `ErrorCode` — throughput exceeded or internal failure) are re-submitted on
 * a bounded schedule; exhausting retries fails the sink with a typed
 * `BatchRetryExhaustedError` carrying the stranded records.
 *
 * Provide the implementation with `Effect.provide(AWS.Kinesis.StreamSinkHttp)`.
 * @binding
 * @section Writing Streams of Records
 * @example Run an Effect Stream into a Kinesis Stream
 * ```typescript
 * // init — bind the sink to the stream
 * const sink = yield* AWS.Kinesis.StreamSink(stream);
 *
 * // runtime — batches into PutRecords calls of up to 500 records / 5 MiB
 * yield* Stream.fromIterable(
 *   orders.map((order) => ({
 *     PartitionKey: order.id,
 *     Data: new TextEncoder().encode(JSON.stringify(order)),
 *   })),
 * ).pipe(Stream.run(sink));
 * ```
 */
export interface StreamSink extends Binding.Service<
  StreamSink,
  "AWS.Kinesis.StreamSink",
  (
    stream: Stream,
  ) => Effect.Effect<
    Sink.Sink<
      void,
      StreamSinkRecord,
      readonly StreamSinkRecord[],
      StreamSinkError
    >
  >
> {}

export const StreamSink = Binding.Service<StreamSink>("AWS.Kinesis.StreamSink");
