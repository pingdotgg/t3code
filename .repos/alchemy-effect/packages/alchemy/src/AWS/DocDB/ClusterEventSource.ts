import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { DBCluster } from "./DBCluster.ts";

/**
 * The `fullDocument` delivery mode for a DocumentDB change-stream event.
 * `UpdateLookup` includes the current full document on updates; `Default`
 * delivers only the change description.
 */
export type FullDocument = "UpdateLookup" | "Default";

/**
 * A single DocumentDB change-stream record delivered to the Lambda function.
 * `TDoc` is the shape of the watched collection's documents.
 */
export interface DocumentDBRecord<TDoc = unknown> {
  /**
   * The change-stream event payload (MongoDB change event).
   */
  event: {
    /** The operation type, e.g. `insert`, `update`, `delete`, `replace`. */
    operationType?: string;
    /** The namespace (database + collection) the change occurred in. */
    ns?: { db?: string; coll?: string };
    /** The full document (present when `fullDocument` is `UpdateLookup`). */
    fullDocument?: TDoc;
    /** The `_id` of the changed document. */
    documentKey?: { _id?: unknown };
    /** The change-stream resume token. */
    _id?: unknown;
  };
}

export interface ClusterEventSourceProps {
  /**
   * The DocumentDB database to watch. Required.
   */
  databaseName: string;
  /**
   * The specific collection to watch. Omit to watch every collection in the
   * database.
   */
  collectionName?: string;
  /**
   * Whether Lambda delivers the full document on update events.
   * @default "Default"
   */
  fullDocument?: FullDocument;
  /**
   * ARN of a Secrets Manager secret holding the DocumentDB connection
   * credentials (`{ username, password }`). Used for `BASIC_AUTH` access.
   * Required — a managed cluster exposes this as `cluster.masterUserSecretArn`.
   */
  secretArn: string;
  /**
   * Maximum number of records per batch delivered to the function.
   */
  batchSize?: number;
  /**
   * Maximum time Lambda spends gathering records before invoking, e.g.
   * `"5 seconds"` or `Duration.seconds(5)`. Rounded to whole seconds on the
   * wire.
   */
  maximumBatchingWindow?: Duration.Input;
  /**
   * Where in the change stream to begin reading.
   * @default "LATEST"
   */
  startingPosition?: "LATEST" | "TRIM_HORIZON";
  /**
   * Whether the mapping is active on create.
   * @default true
   */
  enabled?: boolean;
}

type ChangesHandler<TDoc, Req> = (
  stream: Stream.Stream<DocumentDBRecord<TDoc>>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe an Effect handler to change-stream events produced by an Amazon
 * DocumentDB {@link DBCluster}.
 *
 * The underlying Lambda event-source mapping polls the cluster's change stream
 * and delivers batches of change events. Note that DocumentDB change streams
 * must be enabled on the target database/collection (a data-plane operation run
 * against the cluster) before events flow.
 *
 * @param cluster The DocumentDB cluster to consume change events from.
 * @param props Event-source configuration (database, collection, credentials).
 * @param process The handler invoked with a stream of change records.
 *
 * @example Consume change-stream events in a Lambda function
 * ```typescript
 * // inside the Function's Effect.gen, with
 * // Effect.provide(AWS.Lambda.DocDBClusterEventSource)
 * const secretArn = yield* cluster.masterUserSecretArn;
 * yield* AWS.DocDB.consumeClusterChanges(
 *   cluster,
 *   {
 *     databaseName: "app",
 *     collectionName: "orders",
 *     secretArn,
 *     fullDocument: "UpdateLookup",
 *     startingPosition: "LATEST",
 *   },
 *   (stream) =>
 *     stream.pipe(
 *       Stream.runForEach((record) =>
 *         Effect.log(
 *           `${record.event.operationType}: ${JSON.stringify(record.event.documentKey)}`,
 *         ),
 *       ),
 *     ),
 * );
 * ```
 */
export function consumeClusterChanges<TDoc = unknown, Req = never>(
  cluster: DBCluster,
  props: ClusterEventSourceProps,
  process: ChangesHandler<TDoc, Req>,
): Effect.Effect<void, never, ClusterEventSource> {
  return ClusterEventSource.use((source) => source(cluster, props, process));
}

export class ClusterEventSource extends Context.Service<
  ClusterEventSource,
  ClusterEventSourceService
>()("AWS.DocDB.ClusterEventSource") {}

export type ClusterEventSourceService = <TDoc = unknown, Req = never>(
  cluster: DBCluster,
  props: ClusterEventSourceProps,
  process: (
    stream: Stream.Stream<DocumentDBRecord<TDoc>>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
