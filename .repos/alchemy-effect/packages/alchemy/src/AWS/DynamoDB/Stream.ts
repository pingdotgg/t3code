import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Table, TableEvent, TableRecord } from "./Table.ts";

export type StreamRecord<Data> = TableRecord<Data>;

export type StreamEvent<Data> = TableEvent<Data>;

export class TableEventSource extends Binding.Service<
  TableEventSource,
  TableEventSourceService
>()("AWS.DynamoDB.TableEventSource") {}

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
   * The maximum amount of time, in seconds, that Lambda spends gathering records before invoking the function.
   * @default 0
   */
  maximumBatchingWindowInSeconds?: number;
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
}

export interface StreamsProps extends TableEventSourceProps {
  /**
   * The DynamoDB stream view type to enable on the table.
   * @default "NEW_AND_OLD_IMAGES"
   */
  streamViewType?: DynamoDB.StreamViewType;
}

export const stream = <T extends Table>(
  table: T,
  props: StreamsProps = {},
) => ({
  process: <Data = unknown, Req = never, StreamReq = never>(
    process: (
      stream: Stream.Stream<StreamRecord<Data>, never, StreamReq>,
    ) => Effect.Effect<void, never, Req>,
  ) => TableEventSource.use((source) => source(table, props, process)),
});
