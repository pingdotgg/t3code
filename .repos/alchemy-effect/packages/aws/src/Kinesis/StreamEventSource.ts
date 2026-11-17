import type * as Lambda from "@distilled.cloud/aws/lambda";
import * as Binding from "alchemy/Binding";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Stream as KinesisStream } from "./Stream.ts";

export type KinesisEventRecord = import("aws-lambda").KinesisStreamRecord;

export type KinesisStreamEvent = import("aws-lambda").KinesisStreamEvent;

/**
 * Lambda's partial-batch response for Kinesis. Report the `sequenceNumber`
 * of the first record that failed as `itemIdentifier`; Lambda checkpoints
 * before it and retries from there.
 */
export type KinesisStreamBatchResponse = import("aws-lambda").KinesisStreamBatchResponse;

/**
 * Handler for one delivered batch of Kinesis records: receives the
 * {@link KinesisStreamEvent} and returns Lambda's
 * {@link KinesisStreamBatchResponse} (or `void` when every record succeeded).
 * A failure or defect retries the whole batch.
 */
export type StreamRecordsHandler<E = never, Req = never> = (
  event: KinesisStreamEvent,
) => Effect.Effect<KinesisStreamBatchResponse | void, E, Req>;

export interface StreamEventSourceProps {
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
   * The position in the stream from which Lambda starts reading.
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
  /**
   * A list of current response type enums applied to the event source mapping.
   */
  functionResponseTypes?: "ReportBatchItemFailures"[];
  /**
   * A destination for records that failed processing.
   */
  destinationConfig?: Lambda.DestinationConfig;
  /**
   * Filter criteria to control which records are sent to the function.
   */
  filterCriteria?: Lambda.FilterCriteria;
  /**
   * The ARN of an AWS KMS key to encrypt the filter criteria.
   */
  kmsKeyArn?: string;
  /**
   * Metrics configuration for the event source mapping.
   */
  metricsConfig?: Lambda.EventSourceMappingMetricsConfig;
}

/**
 * Event source connecting a Kinesis `Stream` to the hosting compute.
 *
 * The contract is a `Binding.Service`; the Lambda implementation layer
 * (`AWS.Lambda.StreamEventSource`) creates an event source mapping on the
 * stream, grants the read IAM actions, and hands each delivered batch of
 * `aws:kinesis` records to the handler. Use the {@link consumeStreamRecords} helper
 * rather than calling the service directly.
 * ### Consuming Records
 * **Example:** Process Stream Records in a Lambda Function
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const stream = yield* AWS.Kinesis.Stream("OrdersStream");
 *
 *     // init — registers the event source mapping and the record handler
 *     yield* AWS.Kinesis.consumeStreamRecords(
 *       stream,
 *       { startingPosition: "LATEST", batchSize: 10 },
 *       Effect.fn(function* (event) {
 *         for (const record of event.Records) {
 *           yield* Effect.log(Buffer.from(record.kinesis.data, "base64").toString("utf8"));
 *         }
 *       }),
 *     );
 *
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.StreamEventSource)),
 * );
 * ```
 *
 * @binding
 */
export interface StreamEventSource extends Binding.Service<
  StreamEventSource,
  "AWS.Kinesis.StreamEventSource",
  StreamEventSourceService
> {}

export const StreamEventSource = Binding.Service<StreamEventSource>(
  "AWS.Kinesis.StreamEventSource",
);

export type StreamEventSourceService = <E = never, Req = never>(
  stream: KinesisStream,
  props: StreamEventSourceProps,
  process: StreamRecordsHandler<E, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Subscribe a runtime to batches of records from a Kinesis stream.
 *
 * The Lambda runtime implementation creates an event source mapping and hands
 * each delivered {@link KinesisStreamEvent} (only the records from `stream`)
 * to the handler. Return a {@link KinesisStreamBatchResponse} naming the
 * first failed record's `sequenceNumber` to checkpoint before it, or `void`
 * when every record succeeded. If the handler fails, the whole batch is
 * retried.
 *
 * Each batch runs inside a `process <stream>` span (`SpanKind.CONSUMER`).
 *
 * @example Checkpoint at the first failed record
 * ```typescript
 * const sendMessage = yield* AWS.SQS.SendMessage(queue);
 *
 * yield* AWS.Kinesis.consumeStreamRecords(
 *   stream,
 *   { startingPosition: "LATEST" },
 *   Effect.fn(function* (event) {
 *     for (const record of event.Records) {
 *       const ok = yield* sendMessage({
 *         MessageBody: Buffer.from(record.kinesis.data, "base64").toString("utf8"),
 *       }).pipe(
 *         Effect.as(true),
 *         Effect.catchCause(() => Effect.succeed(false)),
 *       );
 *       if (!ok) {
 *         return { batchItemFailures: [{ itemIdentifier: record.kinesis.sequenceNumber }] };
 *       }
 *     }
 *   }),
 * );
 * ```
 */
export const consumeStreamRecords = <S extends KinesisStream, E = never, Req = never>(
  stream: S,
  props: StreamEventSourceProps = {},
  process: StreamRecordsHandler<E, Req>,
) => StreamEventSource.use((source) => source(stream, props, process));
