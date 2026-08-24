import type * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { Table } from "./Table.ts";

/**
 * A raw distilled Timestream `Record`. Callers stay in control of
 * `Dimensions`, `MeasureName`, `Time`, `Version`, etc. — the sink performs no
 * auto-marshalling.
 */
export type RecordsSinkRecord = TSW.Record;

export interface RecordsSinkProps {
  /**
   * Attributes shared by every record written through this sink (dimensions,
   * measure name, time defaults, version). Sent as `CommonAttributes` on each
   * `WriteRecords` call; Timestream merges them into every record server-side.
   */
  readonly commonAttributes?: TSW.Record;
}

export type RecordsSinkError =
  | Exclude<
      TSW.WriteRecordsError | TSW.DescribeEndpointsError,
      TSW.RejectedRecordsException
    >
  | BatchRetryExhaustedError<RecordsSinkRecord>;

/**
 * A batching sink over Timestream `WriteRecords` (100 records per call).
 *
 * Timestream ingests the valid subset of each batch and reports invalid
 * records positionally via `RejectedRecordsException` (schema conflicts,
 * timestamps outside the retention window, version conflicts). Rejections are
 * **permanent** — the sink drops them (surfacing a warning with the rejected
 * count) and keeps draining; there is no transient per-record failure mode to
 * retry.
 *
 * Provide `Timestream.RecordsSinkHttp` on the Function to implement the
 * binding.
 *
 * @binding
 * @section Streaming Records
 * @example Stream records into a table
 * ```typescript
 * // init — bind the sink to the table; shared attributes are sent once per
 * // batch as CommonAttributes and merged into every record server-side
 * const sink = yield* Timestream.RecordsSink(table, {
 *   commonAttributes: {
 *     MeasureName: "cpu",
 *     MeasureValueType: "DOUBLE",
 *     TimeUnit: "MILLISECONDS",
 *   },
 * });
 *
 * // runtime — drain a stream through the sink (batched 100 records/call)
 * yield* Stream.fromIterable(
 *   samples.map((s) => ({
 *     Dimensions: [{ Name: "host", Value: s.host }],
 *     MeasureValue: `${s.value}`,
 *     Time: `${s.time}`,
 *   })),
 * ).pipe(Stream.run(sink));
 * ```
 */
export interface RecordsSink extends Binding.Service<
  RecordsSink,
  "AWS.Timestream.RecordsSink",
  (
    table: Table,
    props?: RecordsSinkProps,
  ) => Effect.Effect<
    Sink.Sink<
      void,
      RecordsSinkRecord,
      readonly RecordsSinkRecord[],
      RecordsSinkError
    >
  >
> {}

export const RecordsSink = Binding.Service<RecordsSink>(
  "AWS.Timestream.RecordsSink",
);
