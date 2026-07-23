import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Bucket } from "./Bucket.ts";
import { BucketEventSource } from "./BucketEventSource.ts";
import type { S3EventType } from "./S3Event.ts";

/**
 * A normalized S3 event notification record.
 */
export type BucketNotification = {
  /** The S3 event type that triggered this notification. */
  type: S3EventType;
  /** Name of the bucket the event originated from. */
  bucket: string;
  /** Object key that the event applies to. */
  key: string;
  /** Size of the object in bytes. */
  size: number;
  /** ETag of the object. */
  eTag: string;
};

export interface NotificationsProps<Events extends S3EventType[]> {
  /** S3 event types to subscribe to. Defaults to all event types. */
  events?: Events;
}

/**
 * Subscribe to S3 bucket event notifications.
 *
 * Returns an object with a `.subscribe(process)` method that receives a
 * `Stream<BucketNotification>` for processing events.
 *
 * @section Subscribing to Events
 * @example Process all object creation events
 * ```typescript
 * import * as S3 from "alchemy/AWS/S3";
 *
 * yield* S3.notifications(bucket, {
 *   events: ["s3:ObjectCreated:*"],
 * }).subscribe((stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`New object: ${event.key} (${event.size} bytes)`),
 *     ),
 *   ),
 * );
 * ```
 *
 * @example Process all events (no filter)
 * ```typescript
 * yield* S3.notifications(bucket).subscribe((stream) =>
 *   stream.pipe(
 *     Stream.runForEach((event) =>
 *       Effect.log(`${event.type}: ${event.key}`),
 *     ),
 *   ),
 * );
 * ```
 */
export const notifications = <
  B extends Bucket,
  const Events extends S3EventType[] = S3EventType[],
>(
  bucket: B,
  props: NotificationsProps<Events> = {},
) => ({
  subscribe: <Req = never, StreamReq = never>(
    process: (
      stream: Stream.Stream<BucketNotification, never, StreamReq>,
    ) => Effect.Effect<void, never, Req>,
  ) => BucketEventSource.use((source) => source(bucket, props, process)),
});
