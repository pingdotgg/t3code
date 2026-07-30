import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  BucketNotification,
  NotificationsProps,
} from "./BucketNotifications.ts";
import type { S3EventType } from "./S3Event.ts";

/**
 * Event source that streams a bucket's notifications (object created, object
 * removed, ...) into the host Lambda Function. Usually consumed through the
 * `consumeBucketEvents` helper, which provisions the bucket-notification
 * subscription at deploy time and registers the stream handler at runtime.
 * Provide the implementation with `Effect.provide(Lambda.BucketEventSource)`.
 * @binding
 * @section Consuming Bucket Events
 * @example Process Object-Created Events
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const bucket = yield* AWS.S3.Bucket("UploadsBucket");
 *     const putObject = yield* AWS.S3.PutObject(bucket);
 *
 *     // filter to `incoming/` so the derived `processed/` write does not
 *     // re-trigger the subscription
 *     yield* AWS.S3.consumeBucketEvents(
 *       bucket,
 *       { events: ["s3:ObjectCreated:*"], prefix: "incoming/" },
 *       (stream) =>
 *         stream.pipe(
 *           Stream.runForEach((event) =>
 *             putObject({
 *               Key: `processed/${event.key.slice("incoming/".length)}`,
 *               Body: JSON.stringify({ key: event.key, size: event.size }),
 *             }).pipe(Effect.orDie),
 *           ),
 *         ),
 *     );
 *
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(Lambda.BucketEventSource, AWS.S3.PutObjectHttp),
 *     ),
 *   ),
 * );
 * ```
 */
export interface BucketEventSource extends Binding.Service<
  BucketEventSource,
  "BucketNotificationStream",
  BucketEventSourceService
> {}

export const BucketEventSource = Binding.Service<BucketEventSource>(
  "BucketNotificationStream",
);

export type BucketEventSourceService = <
  Events extends S3EventType[],
  StreamReq = never,
  Req = never,
>(
  bucket: Bucket,
  props: NotificationsProps<Events>,
  process: (
    stream: Stream.Stream<BucketNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
