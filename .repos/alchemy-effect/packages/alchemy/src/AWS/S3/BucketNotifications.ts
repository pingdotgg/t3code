import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Bucket } from "./Bucket.ts";
import { BucketEventSource } from "./BucketEventSource.ts";
import type { S3EventType } from "./S3Event.ts";

/**
 * A normalized S3 event notification record.
 */
export type BucketNotification = {
  /** The S3 event type, including the `s3:` prefix. */
  type: S3EventType;
  /** Name of the bucket the event originated from. */
  bucket: string;
  /** URL-decoded object key that the event applies to. */
  key: string;
  /** Size in bytes, when supplied; removal events may omit it. */
  size?: number;
  /** Object ETag, when supplied; removal events may omit it. */
  eTag?: string;
  /**
   * Object or delete-marker version ID. Pass as GetObject's VersionId to read
   * the exact data version; delete markers are not readable objects.
   */
  versionId?: string;
  /** Ordering token for events affecting the same key, when supplied. */
  sequencer?: string;
};

export interface NotificationsProps<Events extends S3EventType[]> {
  /** S3 event types to subscribe to. Defaults to `s3:ObjectCreated:*`. */
  events?: Events;
  /**
   * Only deliver events for object keys beginning with this prefix.
   * Maps to an S3 `prefix` filter rule on the notification configuration.
   */
  prefix?: string;
  /**
   * Only deliver events for object keys ending with this suffix.
   * Maps to an S3 `suffix` filter rule on the notification configuration.
   */
  suffix?: string;
}

/**
 * Subscribe to S3 bucket event notifications.
 *
 * The handler receives a `Stream<BucketNotification>` for processing events
 * and is passed as the final positional argument.
 * ### Subscribing to Events
 * **Example:** Process all object creation events
 * ```typescript
 * import * as S3 from "alchemy/AWS/S3";
 *
 * yield* S3.consumeBucketEvents(
 *   bucket,
 *   { events: ["s3:ObjectCreated:*"] },
 *   (stream) =>
 *     stream.pipe(
 *       Stream.runForEach((event) =>
 *         Effect.log(`New object: ${event.key} (${event.size} bytes)`),
 *       ),
 *     ),
 * );
 * ```
 *
 * **Example:** Process object creation events without a key filter
 * ```typescript
 * yield* S3.consumeBucketEvents(bucket, (stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`${event.type}: ${event.key}`),
 *     ),
 *   ),
 * );
 * ```
 *
 * @binding
 */
export function consumeBucketEvents<
  B extends Bucket,
  Req = never,
  StreamReq = never,
  const Events extends S3EventType[] = S3EventType[],
>(
  bucket: B,
  handler: (
    stream: Stream.Stream<BucketNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, Req>;
export function consumeBucketEvents<
  B extends Bucket,
  Req = never,
  StreamReq = never,
  const Events extends S3EventType[] = S3EventType[],
>(
  bucket: B,
  props: NotificationsProps<Events>,
  handler: (
    stream: Stream.Stream<BucketNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, Req>;
export function consumeBucketEvents<
  B extends Bucket,
  Req = never,
  StreamReq = never,
  const Events extends S3EventType[] = S3EventType[],
>(
  bucket: B,
  propsOrHandler:
    | NotificationsProps<Events>
    | ((
        stream: Stream.Stream<BucketNotification, never, StreamReq>,
      ) => Effect.Effect<void, never, Req>),
  maybeHandler?: (
    stream: Stream.Stream<BucketNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) {
  const props: NotificationsProps<Events> =
    typeof propsOrHandler === "function" ? {} : propsOrHandler;
  const handler =
    typeof propsOrHandler === "function" ? propsOrHandler : maybeHandler!;
  return BucketEventSource.use((source) => source(bucket, props, handler));
}
