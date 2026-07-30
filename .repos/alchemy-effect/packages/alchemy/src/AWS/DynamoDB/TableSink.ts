import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { Table } from "./Table.ts";

/**
 * A raw distilled `WriteRequest` — exactly one of `PutRequest` or
 * `DeleteRequest`. Entries are NOT auto-marshalled: callers construct the
 * `AttributeValue` maps themselves, keeping full control over item shape,
 * ordering, and partitioning.
 */
export interface TableSinkEntry extends DynamoDB.WriteRequest {}

export type TableSinkError =
  | DynamoDB.BatchWriteItemError
  | BatchRetryExhaustedError<TableSinkEntry>;

/**
 * A batching sink over DynamoDB `BatchWriteItem` (25 write requests / 16 MB
 * per call). Entries the API echoes back in `UnprocessedItems` (throttling,
 * internal errors) are re-submitted on a bounded schedule; exhausting retries
 * fails the sink with a typed `BatchRetryExhaustedError` carrying the
 * stranded entries.
 *
 * Sinks are request-scoped consumers: acquire the sink during the Function's
 * init, drive it with `Stream.run` inside a handler, and let it drain fully
 * before the handler returns.
 *
 * @binding
 * @section Streaming Writes
 * @example Stream Put Requests into a Table
 * ```typescript
 * const sink = yield* AWS.DynamoDB.TableSink(table);
 *
 * yield* Stream.fromIterable(records).pipe(
 *   Stream.map((record): AWS.DynamoDB.TableSinkEntry => ({
 *     PutRequest: {
 *       Item: {
 *         pk: { S: record.pk },
 *         sk: { S: record.sk },
 *       },
 *     },
 *   })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * @example Stream Delete Requests into a Table
 * ```typescript
 * yield* Stream.fromIterable(keys).pipe(
 *   Stream.map((key): AWS.DynamoDB.TableSinkEntry => ({
 *     DeleteRequest: {
 *       Key: {
 *         pk: { S: key.pk },
 *         sk: { S: key.sk },
 *       },
 *     },
 *   })),
 *   Stream.run(sink),
 * );
 * ```
 */
export interface TableSink extends Binding.Service<
  TableSink,
  "AWS.DynamoDB.TableSink",
  (
    table: Table,
  ) => Effect.Effect<
    Sink.Sink<void, TableSinkEntry, readonly TableSinkEntry[], TableSinkError>
  >
> {}

export const TableSink = Binding.Service<TableSink>("AWS.DynamoDB.TableSink");
