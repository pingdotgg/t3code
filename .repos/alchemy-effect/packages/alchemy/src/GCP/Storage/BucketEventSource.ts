import type * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type {
  TopicEventSourceProps,
  TopicMessage,
} from "../PubSub/TopicEventSource.ts";
import type { Bucket } from "./Bucket.ts";

/** Cloud Storage object event types delivered through Pub/Sub. */
export type BucketEventType =
  | "OBJECT_FINALIZE"
  | "OBJECT_DELETE"
  | "OBJECT_ARCHIVE"
  | "OBJECT_METADATA_UPDATE";

/** One Cloud Storage object change. */
export interface BucketEvent {
  /** What happened to the object. */
  eventType: BucketEventType;
  /** Bucket the object lives in. */
  bucket: string;
  /** Object name (key). */
  object: string;
  /** Object generation the event refers to. */
  generation: string;
  /** RFC3339 time the event occurred. */
  eventTime: string;
  /**
   * Object metadata at the time of the event (the `JSON_API_V1` payload):
   * `size`, `contentType`, `md5Hash`, `metadata`, …
   */
  metadata: storage.Storage_Object;
}

export interface BucketEventSourceProps extends Omit<
  TopicEventSourceProps,
  "filter"
> {
  /**
   * Event types to deliver. Filtered by the bucket notification, so other
   * events never reach the host.
   * @default ["OBJECT_FINALIZE"]
   */
  eventTypes?: BucketEventType[];
  /**
   * Only deliver events for objects whose names start with this prefix.
   * Filtered by the bucket notification.
   */
  prefix?: string;
}

export type BucketEventsHandler<Req> = (
  events: Stream.Stream<BucketEvent>,
) => Effect.Effect<void, never, Req>;

export type BucketEventSourceService = <Req = never>(
  bucket: Bucket,
  props: BucketEventSourceProps,
  process: BucketEventsHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source streaming a Cloud Storage {@link Bucket}'s object changes
 * (created, deleted, archived, metadata updated) into the hosting compute.
 *
 * `GCP.Storage.BucketEventSourceLive` provisions a Pub/Sub topic owned by
 * the host plus a `JSON_API_V1` bucket notification on it (filtered by
 * event type and object prefix), then delegates delivery to whichever
 * `GCP.PubSub.TopicEventSource` implementation is provided alongside it:
 * `GCP.Run.TopicEventSource` (push, for `GCP.Function` /
 * `GCP.CloudFunctions.Function`) or `GCP.Run.TopicPullEventSource` (pull,
 * for `GCP.Run.Job` / `GCP.Run.WorkerPool`).
 *
 * Consume it through {@link consumeBucketEvents}.
 *
 * ### Consuming Bucket Events
 * **Example:** Process uploads on a Cloud Run service
 * ```typescript
 * export class Thumbnails extends GCP.Function<Thumbnails>()(
 *   "Thumbnails",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const uploads = yield* GCP.Storage.Bucket("Uploads", {});
 *     yield* GCP.Storage.consumeBucketEvents(
 *       uploads,
 *       { prefix: "incoming/" },
 *       (events) =>
 *         events.pipe(
 *           Stream.runForEach((event) =>
 *             Effect.log(`${event.object} (${event.metadata.size} bytes)`),
 *           ),
 *         ),
 *     );
 *   }).pipe(
 *     Effect.provide(GCP.Storage.BucketEventSourceLive),
 *     Effect.provide(GCP.Run.TopicEventSource),
 *   ),
 * ) {}
 * ```
 *
 * **Example:** Deletions on a worker pool
 * ```typescript
 * yield* GCP.Storage.consumeBucketEvents(
 *   uploads,
 *   { eventTypes: ["OBJECT_DELETE", "OBJECT_ARCHIVE"] },
 *   (events) => events.pipe(Stream.runForEach(handle)),
 * );
 * // …provided with GCP.Storage.BucketEventSourceLive
 * // and GCP.Run.TopicPullEventSource
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BucketEventSource extends Binding.Service<
  BucketEventSource,
  "GCP.Storage.BucketEventSource",
  BucketEventSourceService
> {}

export const BucketEventSource = Binding.Service<BucketEventSource>(
  "GCP.Storage.BucketEventSource",
);

/**
 * Subscribe an Effect handler to object changes in a Cloud Storage
 * {@link Bucket}. See {@link BucketEventSource} for the implementations.
 */
export function consumeBucketEvents<Req = never, ResourceReq = never>(
  bucket: Bucket | Effect.Effect<Bucket, never, ResourceReq>,
  process: BucketEventsHandler<Req>,
): Effect.Effect<void, never, BucketEventSource | ResourceReq>;
export function consumeBucketEvents<Req = never, ResourceReq = never>(
  bucket: Bucket | Effect.Effect<Bucket, never, ResourceReq>,
  props: BucketEventSourceProps,
  process: BucketEventsHandler<Req>,
): Effect.Effect<void, never, BucketEventSource | ResourceReq>;
export function consumeBucketEvents<Req = never, ResourceReq = never>(
  bucket: Bucket | Effect.Effect<Bucket, never, ResourceReq>,
  propsOrProcess: BucketEventSourceProps | BucketEventsHandler<Req>,
  maybeProcess?: BucketEventsHandler<Req>,
): Effect.Effect<void, never, BucketEventSource | ResourceReq> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as BucketEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  // Accept the resource or the Effect that declares it, like bindings do.
  const resolved = Effect.isEffect(bucket) ? bucket : Effect.succeed(bucket);
  return resolved.pipe(
    Effect.flatMap((value) =>
      BucketEventSource.use((source) => source(value, props, process)),
    ),
  );
}

const decodeBase64Utf8 = (data: string) => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

/**
 * Parse a Cloud Storage Pub/Sub notification into a {@link BucketEvent}.
 * The routing fields come from the message attributes; `metadata` is the
 * `JSON_API_V1` object resource in `data` (empty when the notification
 * uses `NONE` or the payload is unreadable).
 */
export const toBucketEvent = ({ message }: TopicMessage) =>
  Effect.sync((): BucketEvent => {
    const attributes = message.attributes ?? {};
    let metadata: storage.Storage_Object = {};
    try {
      if (message.data) {
        metadata = JSON.parse(
          decodeBase64Utf8(message.data),
        ) as storage.Storage_Object;
      }
    } catch {
      metadata = {};
    }
    return {
      eventType: (attributes.eventType ?? "OBJECT_FINALIZE") as BucketEventType,
      bucket: attributes.bucketId ?? metadata.bucket ?? "",
      object: attributes.objectId ?? metadata.name ?? "",
      generation:
        attributes.objectGeneration ?? String(metadata.generation ?? ""),
      eventTime: attributes.eventTime ?? message.publishTime ?? "",
      metadata,
    };
  });
