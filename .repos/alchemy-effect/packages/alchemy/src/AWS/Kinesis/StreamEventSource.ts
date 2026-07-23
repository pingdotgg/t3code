import type * as Lambda from "@distilled.cloud/aws/lambda";
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
   * The maximum amount of time, in seconds, that Lambda spends gathering records before invoking the function.
   * @default 0
   */
  maximumBatchingWindowInSeconds?: number;
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
   * Discard records older than the specified age in seconds.
   * @default -1
   */
  maximumRecordAgeInSeconds?: number;
  /**
   * Discard records after the specified number of retries.
   * @default -1
   */
  maximumRetryAttempts?: number;
  /**
   * The duration in seconds of a processing window for tumbling windows.
   */
  tumblingWindowInSeconds?: number;
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

export class StreamEventSource extends Binding.Service<
  StreamEventSource,
  StreamEventSourceService
>()("AWS.Kinesis.StreamEventSource") {}

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
 */
export const records = <S extends KinesisStream>(
  stream: S,
  props: StreamEventSourceProps = {},
) => ({
  process: <Req = never, StreamReq = never>(
    process: (
      stream: Stream.Stream<KinesisEventRecord, never, StreamReq>,
    ) => Effect.Effect<void, never, Req>,
  ) => StreamEventSource.use((source) => source(stream, props, process)),
});
