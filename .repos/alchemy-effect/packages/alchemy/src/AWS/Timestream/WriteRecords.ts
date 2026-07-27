import type * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface WriteRecordsRequest extends Omit<
  TSW.WriteRecordsRequest,
  "DatabaseName" | "TableName"
> {}

/**
 * Runtime binding for `timestream-write:WriteRecords` — ingest time-series
 * records into a Timestream {@link Table}.
 *
 * Bind the operation to a table inside a function runtime to get a callable
 * with `DatabaseName` and `TableName` injected automatically; you only supply
 * the `Records` (and optional `CommonAttributes`). For high-volume streaming
 * ingestion prefer the batching {@link RecordsSink}.
 *
 * Provide `Timestream.WriteRecordsHttp` on the Function to implement the
 * binding.
 *
 * @binding
 * @section Writing Records
 * @example Write a measurement
 * ```typescript
 * // init — bind the operation to the table
 * const writeRecords = yield* Timestream.WriteRecords(table);
 *
 * // runtime — ingest a record
 * const result = yield* writeRecords({
 *   Records: [
 *     {
 *       Dimensions: [{ Name: "host", Value: "web-1" }],
 *       MeasureName: "cpu",
 *       MeasureValue: "42.5",
 *       MeasureValueType: "DOUBLE",
 *       Time: `${Date.now()}`,
 *       TimeUnit: "MILLISECONDS",
 *     },
 *   ],
 * });
 * // result.RecordsIngested reports how many records landed
 * ```
 */
export interface WriteRecords extends Binding.Service<
  WriteRecords,
  "AWS.Timestream.WriteRecords",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: WriteRecordsRequest,
    ) => Effect.Effect<
      TSW.WriteRecordsResponse,
      TSW.WriteRecordsError | TSW.DescribeEndpointsError
    >
  >
> {}

export const WriteRecords = Binding.Service<WriteRecords>(
  "AWS.Timestream.WriteRecords",
);
