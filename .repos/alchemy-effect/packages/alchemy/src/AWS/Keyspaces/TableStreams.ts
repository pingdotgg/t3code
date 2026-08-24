import type * as keyspacesstreams from "@distilled.cloud/aws/keyspacesstreams";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ListTableStreamsRequest extends Omit<
  keyspacesstreams.ListStreamsInput,
  "keyspaceName" | "tableName"
> {}

/**
 * The typed client returned by binding {@link TableStreams} to a `Table`.
 * `listStreams` automatically injects the table's keyspace and table name;
 * the remaining operations traverse a stream by ARN / shard iterator
 * obtained from prior calls.
 */
export interface TableStreamsClient {
  /**
   * List the CDC streams of the bound table (the stream with the greatest
   * `streamLabel` is the current one — also exposed as the table's
   * `latestStreamArn` attribute).
   */
  listStreams: (
    request?: ListTableStreamsRequest,
  ) => Effect.Effect<
    keyspacesstreams.ListStreamsOutput,
    keyspacesstreams.ListStreamsError
  >;
  /**
   * Describe a stream: status, view type, retention, and shard composition.
   */
  getStream: (
    request: keyspacesstreams.GetStreamInput,
  ) => Effect.Effect<
    keyspacesstreams.GetStreamOutput,
    keyspacesstreams.GetStreamError
  >;
  /**
   * Obtain an iterator positioned in a shard (`TRIM_HORIZON`, `LATEST`,
   * `AT_SEQUENCE_NUMBER`, or `AFTER_SEQUENCE_NUMBER`).
   */
  getShardIterator: (
    request: keyspacesstreams.GetShardIteratorInput,
  ) => Effect.Effect<
    keyspacesstreams.GetShardIteratorOutput,
    keyspacesstreams.GetShardIteratorError
  >;
  /**
   * Read change records from a shard iterator.
   */
  getRecords: (
    request: keyspacesstreams.GetRecordsInput,
  ) => Effect.Effect<
    keyspacesstreams.GetRecordsOutput,
    keyspacesstreams.GetRecordsError
  >;
}

/**
 * Runtime binding for the Amazon Keyspaces CDC streams data-plane API
 * (`cassandra:ListStreams` / `GetStream` / `GetShardIterator` /
 * `GetRecords`).
 *
 * Bind this to a `Table` whose `cdcSpecification` is enabled to get a typed
 * client for traversing the table's change-data-capture stream.
 * @binding
 * @section Reading Change Data
 * @example Traverse the Latest Stream
 * ```typescript
 * const streams = yield* AWS.Keyspaces.TableStreams(table);
 *
 * const { streams: available } = yield* streams.listStreams();
 * const streamArn = available![0].streamArn;
 *
 * const stream = yield* streams.getStream({ streamArn });
 * const { shardIterator } = yield* streams.getShardIterator({
 *   streamArn,
 *   shardId: stream.shards![0].shardId!,
 *   shardIteratorType: "TRIM_HORIZON",
 * });
 *
 * const { changeRecords } = yield* streams.getRecords({
 *   shardIterator: shardIterator!,
 * });
 * ```
 */
export interface TableStreams extends Binding.Service<
  TableStreams,
  "AWS.Keyspaces.TableStreams",
  <T extends Table>(table: T) => Effect.Effect<TableStreamsClient>
> {}
export const TableStreams = Binding.Service<TableStreams>(
  "AWS.Keyspaces.TableStreams",
);
