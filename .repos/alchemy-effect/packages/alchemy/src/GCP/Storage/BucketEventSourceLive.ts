import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import * as Namespace from "../../Namespace.ts";
import { Topic } from "../PubSub/Topic.ts";
import { TopicEventSource } from "../PubSub/TopicEventSource.ts";
import type { Bucket } from "./Bucket.ts";
import {
  BucketEventSource,
  toBucketEvent,
  type BucketEvent,
  type BucketEventSourceProps,
  type BucketEventSourceService,
} from "./BucketEventSource.ts";
import { Notification } from "./Notification.ts";

/**
 * Implementation of `GCP.Storage.BucketEventSource` over Pub/Sub.
 *
 * Deploy-time: creates a Pub/Sub topic owned by the host
 * (`{bucket}-BucketEvents`) and a `JSON_API_V1` bucket notification that
 * publishes the requested event types (and object prefix) to it; the
 * notification grants the Cloud Storage service agent
 * `roles/pubsub.publisher` on the topic. Delivery is delegated to the
 * provided `GCP.PubSub.TopicEventSource` implementation, so provide one
 * alongside this layer: `GCP.Run.TopicEventSource` (push, HTTP hosts) or
 * `GCP.Run.TopicPullEventSource` (pull, Jobs and WorkerPools). Runtime:
 * each message is parsed into a `BucketEvent`.
 *
 * ### Choosing the delivery
 * **Example:** Push to a Cloud Run service
 * ```typescript
 * Effect.gen(function* () {
 *   yield* GCP.Storage.consumeBucketEvents(bucket, (events) =>
 *     events.pipe(Stream.runForEach((event) => Effect.log(event.object))),
 *   );
 * }).pipe(
 *   Effect.provide(GCP.Storage.BucketEventSourceLive),
 *   Effect.provide(GCP.Run.TopicEventSource),
 * );
 * ```
 *
 * **Example:** Pull on a worker pool
 * ```typescript
 * Effect.gen(function* () {
 *   yield* GCP.Storage.consumeBucketEvents(bucket, (events) =>
 *     events.pipe(Stream.runForEach((event) => Effect.log(event.object))),
 *   );
 *   return { run: Effect.never };
 * }).pipe(
 *   Effect.provide(GCP.Storage.BucketEventSourceLive),
 *   Effect.provide(GCP.Run.TopicPullEventSource),
 * );
 * ```
 *
 * @layer
 * @provides GCP.Storage.BucketEventSource
 * @category Storage
 */
export const BucketEventSourceLive = Layer.effect(
  BucketEventSource,
  Effect.gen(function* () {
    const topics = yield* Topic;
    const notifications = yield* Notification;
    const source = yield* TopicEventSource;

    return Effect.fn(function* <Req = never>(
      bucket: Bucket,
      props: BucketEventSourceProps,
      process: (
        events: Stream.Stream<BucketEvent>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* Binding.Host;
      const hostId = host?.LogicalId ?? "Host";
      // Declared in both phases: the delivery implementation declares its
      // subscription against this topic at runtime too.
      const topic = yield* Namespace.push(
        hostId,
        topics(`${bucket.LogicalId}-BucketEvents`, {}),
      );

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          hostId,
          notifications(`${bucket.LogicalId}-Notification`, {
            bucketName: bucket.bucketName,
            topic: topic.name,
            payloadFormat: "JSON_API_V1",
            eventTypes: props.eventTypes ?? ["OBJECT_FINALIZE"],
            objectNamePrefix: props.prefix,
          }),
        );
      }

      const { eventTypes: _eventTypes, prefix: _prefix, ...delivery } = props;
      yield* source(topic, delivery, (messages) =>
        process(messages.pipe(Stream.mapEffect(toBucketEvent))),
      );
    }) as BucketEventSourceService;
  }),
);
