import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import type * as lambda from "aws-lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Table, TableEvent, TableRecord } from "./Table.ts";

export type StreamRecord<Data> = TableRecord<Data>;

export type StreamEvent<Data> = TableEvent<Data>;

/**
 * Lambda's partial-batch response for DynamoDB Streams. Report the
 * `SequenceNumber` of the first record that failed as `itemIdentifier`;
 * Lambda checkpoints before it and retries from there.
 */
export type DynamoDBBatchResponse = import("aws-lambda").DynamoDBBatchResponse;

/**
 * Handler for one delivered batch of table changes: receives the
 * {@link StreamEvent} and returns Lambda's {@link DynamoDBBatchResponse} (or
 * `void` when every record succeeded). A failure or defect retries the whole
 * batch.
 *
 * Row images default to raw attribute values; annotate the parameter
 * (`event: DynamoDB.StreamEvent<Order>`) to type them. The method form keeps
 * the parameter bivariant so an annotated handler is accepted.
 */
export type TableChangesHandler<E = never, Req = never> = {
  handle(
    event: StreamEvent<Record<string, lambda.AttributeValue>>,
  ): Effect.Effect<DynamoDBBatchResponse | void, E, Req>;
}["handle"];

/**
 * Event source binding that subscribes a Lambda function to a DynamoDB
 * table's change stream. Enables the stream on the table (via the binding
 * contract) and creates the Lambda event source mapping.
 *
 * Prefer the {@link consumeTableChanges} helper for ergonomic use; provide
 * the runtime-specific implementation layer (e.g. `Lambda.TableEventSource`)
 * on the Function.
 *
 * @binding
 */
export interface TableEventSource extends Binding.Service<
  TableEventSource,
  "AWS.DynamoDB.TableEventSource",
  TableEventSourceService
> {}
export const TableEventSource = Binding.Service<TableEventSource>("AWS.DynamoDB.TableEventSource");

export type TableEventSourceService = <E = never, Req = never>(
  table: Table,
  props: StreamsProps,
  process: TableChangesHandler<E, Req>,
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
 * binding contract.
 *
 * The handler receives each delivered {@link StreamEvent} (only the records
 * from `table`) and returns Lambda's {@link DynamoDBBatchResponse}: name the
 * first failed record's `SequenceNumber` to checkpoint before it, or return
 * `void` when every record succeeded. If the handler fails, the whole batch is
 * retried.
 *
 * Each batch runs inside a `process <table>` span (`SpanKind.CONSUMER`).
 *
 * Provide `Lambda.TableEventSource` on the Function to satisfy the binding.
 *
 * @example Log every table change
 * ```typescript
 * yield* DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_AND_OLD_IMAGES", startingPosition: "TRIM_HORIZON" },
 *   Effect.fn(function* (event) {
 *     for (const record of event.Records) {
 *       yield* Effect.log(`${record.eventName}: ${JSON.stringify(record.dynamodb.Keys)}`);
 *     }
 *   }),
 * );
 * ```
 *
 * @example Type the row images
 * ```typescript
 * interface Order {
 *   id: { S: string };
 *   status: { S: string };
 * }
 *
 * yield* DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_IMAGE" },
 *   Effect.fn(function* (event: DynamoDB.StreamEvent<Order>) {
 *     for (const record of event.Records) {
 *       yield* Effect.log(record.dynamodb.NewImage?.status.S);
 *     }
 *   }),
 * );
 * ```
 *
 * @example Checkpoint at the first failed record
 * ```typescript
 * const sendMessage = yield* AWS.SQS.SendMessage(queue);
 *
 * yield* DynamoDB.consumeTableChanges(
 *   table,
 *   { streamViewType: "NEW_AND_OLD_IMAGES", batchSize: 10 },
 *   Effect.fn(function* (event) {
 *     for (const record of event.Records) {
 *       const ok = yield* sendMessage({
 *         MessageBody: JSON.stringify({
 *           eventName: record.eventName,
 *           keys: record.dynamodb.Keys,
 *           newImage: record.dynamodb.NewImage,
 *         }),
 *       }).pipe(
 *         Effect.as(true),
 *         Effect.catchCause(() => Effect.succeed(false)),
 *       );
 *       if (!ok) {
 *         return { batchItemFailures: [{ itemIdentifier: record.dynamodb.SequenceNumber! }] };
 *       }
 *     }
 *   }),
 * );
 * ```
 */
export const consumeTableChanges = <E = never, Req = never>(
  table: Table,
  props: StreamsProps = {},
  handler: TableChangesHandler<E, Req>,
) => TableEventSource.use((source) => source(table, props, handler));
