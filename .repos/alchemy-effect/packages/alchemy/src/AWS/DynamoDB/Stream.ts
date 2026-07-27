import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Table, TableEvent, TableRecord } from "./Table.ts";

export type StreamRecord<Data> = TableRecord<Data>;

export type StreamEvent<Data> = TableEvent<Data>;

/**
 * Event source binding that subscribes a Lambda function to a DynamoDB
 * table's change stream. Enables the stream on the table (via the binding
 * contract) and creates the Lambda event source mapping.
 *
 * Prefer the {@link consumeTableChanges} helper for ergonomic use; provide
 * the runtime-specific implementation layer (e.g. `Lambda.TableEventSource`)
 * on the Function.
 * @binding
 */
export interface TableEventSource extends Binding.Service<
  TableEventSource,
  "AWS.DynamoDB.TableEventSource",
  TableEventSourceService
> {}
export const TableEventSource = Binding.Service<TableEventSource>(
  "AWS.DynamoDB.TableEventSource",
);

export type TableEventSourceService = <
  Data = unknown,
  StreamReq = never,
  Req = never,
>(
  table: Table,
  props: StreamsProps,
  process: (
    stream: Stream.Stream<StreamRecord<Data>, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export interface TableEventSourceProps {
  /**
   * The maximum number of records in each batch that Lambda pulls from the stream.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum amount of time that Lambda spends gathering records before
   * invoking the function, e.g. `"5 seconds"` or `Duration.seconds(5)`.
   * Rounded to whole seconds on the wire.
   * @default 0
   */
  maximumBatchingWindow?: Duration.Input;
  /**
   * The position in the stream from which to start reading.
   * @default "LATEST"
   */
  startingPosition?: "TRIM_HORIZON" | "LATEST" | "AT_TIMESTAMP";
  /**
   * The timestamp to start reading from when `startingPosition` is `AT_TIMESTAMP`.
   */
  startingPositionTimestamp?: Date;
  /**
   * The number of batches to process from each shard concurrently.
   * @default 1
   */
  parallelizationFactor?: number;
  /**
   * Split the batch in two and retry if the function returns an error.
   * @default false
   */
  bisectBatchOnFunctionError?: boolean;
  /**
   * Discard records older than the specified age, e.g. `"1 hour"` or
   * `Duration.hours(1)`. Rounded to whole seconds on the wire. Omit to never
   * discard records by age.
   */
  maximumRecordAge?: Duration.Input;
  /**
   * Discard records after the specified number of retries.
   * @default -1
   */
  maximumRetryAttempts?: number;
  /**
   * The duration of a processing window for tumbling windows, e.g.
   * `"30 seconds"` or `Duration.seconds(30)`. Rounded to whole seconds on
   * the wire (0–900 seconds).
   */
  tumblingWindow?: Duration.Input;
}

export interface StreamsProps extends TableEventSourceProps {
  /**
   * The DynamoDB stream view type to enable on the table.
   * @default "NEW_AND_OLD_IMAGES"
   */
  streamViewType?: DynamoDB.StreamViewType;
}

/**
 * Consume change data capture events from a DynamoDB table via a Lambda
 * event source mapping. The stream is enabled automatically through the
 * binding contract. The handler receives each delivered batch as an Effect
 * `Stream` of change records.
 *
 * Provide `Lambda.TableEventSource` on the Function to satisfy the binding.
 *
 * @example Log every table change
 * ```typescript
 * yield* DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_AND_OLD_IMAGES", startingPosition: "TRIM_HORIZON" },
 *   (stream) =>
 *     stream.pipe(
 *       Stream.runForEach((record) =>
 *         Effect.log(`${record.eventName}: ${JSON.stringify(record.dynamodb.Keys)}`),
 *       ),
 *     ),
 * );
 * ```
 *
 * @example Forward changes to an SQS queue via QueueSink
 * ```typescript
 * const sink = yield* AWS.SQS.QueueSink(queue);
 *
 * yield* DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_AND_OLD_IMAGES", batchSize: 10 },
 *   (stream) =>
 *     stream.pipe(
 *       Stream.map((record) => ({
 *         MessageBody: JSON.stringify({
 *           eventName: record.eventName,
 *           keys: record.dynamodb.Keys,
 *           newImage: record.dynamodb.NewImage,
 *         }),
 *       })),
 *       Stream.run(sink),
 *       Effect.orDie,
 *     ),
 * );
 * ```
 */
export const consumeTableChanges = <
  Data = unknown,
  Req = never,
  StreamReq = never,
>(
  table: Table,
  props: StreamsProps = {},
  handler: (
    stream: Stream.Stream<StreamRecord<Data>, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => TableEventSource.use((source) => source(table, props, handler));
