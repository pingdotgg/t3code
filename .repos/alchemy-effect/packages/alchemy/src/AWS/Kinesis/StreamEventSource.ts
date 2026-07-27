import type * as Lambda from "@distilled.cloud/aws/lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Stream as KinesisStream } from "./Stream.ts";

export type KinesisEventRecord = import("aws-lambda").KinesisStreamRecord;

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
 * stream, grants the read IAM actions, and forwards `aws:kinesis` records
 * into the handler's `Stream`. Use the {@link consumeStreamRecords} helper
 * rather than calling the service directly.
 * @binding
 * @section Consuming Records
 * @example Process Stream Records in a Lambda Function
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
 *       (records) =>
 *         records.pipe(
 *           Stream.runForEach((record) =>
 *             Effect.log(
 *               Buffer.from(record.kinesis.data, "base64").toString("utf8"),
 *             ),
 *           ),
 *         ),
 *     );
 *
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.StreamEventSource)),
 * );
 * ```
 */
export interface StreamEventSource extends Binding.Service<
  StreamEventSource,
  "AWS.Kinesis.StreamEventSource",
  StreamEventSourceService
> {}

export const StreamEventSource = Binding.Service<StreamEventSource>(
  "AWS.Kinesis.StreamEventSource",
);

export type StreamEventSourceService = <StreamReq = never, Req = never>(
  stream: KinesisStream,
  props: StreamEventSourceProps,
  process: (
    stream: Stream.Stream<KinesisEventRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Subscribe a runtime to records from a Kinesis stream.
 *
 * The Lambda runtime implementation creates an event source mapping and forwards
 * matching `aws:kinesis` records into the supplied `Stream`.
 *
 * @example Forward stream records into an SQS queue
 * ```typescript
 * const sink = yield* AWS.SQS.QueueSink(queue);
 *
 * yield* AWS.Kinesis.consumeStreamRecords(
 *   stream,
 *   { startingPosition: "LATEST" },
 *   (records) =>
 *     records.pipe(
 *       Stream.map((record) => ({
 *         MessageBody: Buffer.from(record.kinesis.data, "base64").toString("utf8"),
 *       })),
 *       Stream.run(sink),
 *       Effect.orDie,
 *     ),
 * );
 * ```
 */
export const consumeStreamRecords = <
  S extends KinesisStream,
  Req = never,
  StreamReq = never,
>(
  stream: S,
  props: StreamEventSourceProps = {},
  process: (
    stream: Stream.Stream<KinesisEventRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => StreamEventSource.use((source) => source(stream, props, process));
