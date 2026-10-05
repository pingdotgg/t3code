import * as GCP from "@/GCP";
import type { TopicMessage } from "@/GCP/PubSub/TopicEventSource.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Marker object a consumer writes for one delivered message. */
export const markerFor = (messageId: string) => `markers/${messageId}.json`;

export const PushOrders = GCP.PubSub.Topic("PushOrders", {});
export const PullOrders = GCP.PubSub.Topic("PullOrders", {});
export const Markers = GCP.Storage.Bucket("TopicMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

const recordMessages =
  (
    putObject: (request: {
      name: string;
      body: string;
    }) => Effect.Effect<unknown, unknown, any>,
  ) =>
  (messages: Stream.Stream<TopicMessage>) =>
    messages.pipe(
      Stream.runForEach(({ message, subscription }) =>
        putObject({
          name: markerFor(message.messageId ?? "unknown"),
          body: JSON.stringify({
            data: atob(message.data ?? ""),
            attributes: message.attributes ?? {},
            subscription,
          }),
        }).pipe(Effect.asVoid, Effect.orDie),
      ),
    );

/**
 * Effect-native Cloud Run service consuming a topic over push. The
 * service keeps the default IAM invoker check, so deliveries must carry a
 * token Cloud Run accepts.
 * Deployed from {@link ../TopicEventSource.test.ts}.
 */
export class PushConsumer extends GCP.Function<PushConsumer>()(
  "PushConsumer",
  {
    main: import.meta.url,
    handler: "PushConsumer",
    location: "us-central1",
  },
  Effect.gen(function* () {
    const topic = yield* PushOrders;
    const bucket = yield* Markers;
    const putObject = yield* GCP.Storage.PutObject(bucket);
    yield* GCP.PubSub.consumeTopicMessages(topic, recordMessages(putObject));
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide(GCP.Run.TopicEventSource),
    Effect.provide(GCP.Storage.PutObjectHttp),
  ),
) {}

/**
 * Effect-native Cloud Run worker pool consuming a topic with a pull loop.
 * Deployed from {@link ../TopicEventSource.test.ts}.
 */
export class PullConsumer extends GCP.Run.WorkerPool<PullConsumer>()(
  "PullConsumer",
  {
    main: import.meta.url,
    handler: "PullConsumer",
    location: "us-central1",
    scaling: { manualInstanceCount: 1 },
  },
  Effect.gen(function* () {
    const topic = yield* PullOrders;
    const bucket = yield* Markers;
    const putObject = yield* GCP.Storage.PutObject(bucket);
    yield* GCP.PubSub.consumeTopicMessages(
      topic,
      { maxMessages: 5 },
      recordMessages(putObject),
    );
  }).pipe(
    Effect.provide(GCP.Run.TopicPullEventSource),
    Effect.provide(GCP.Storage.PutObjectHttp),
  ),
) {}
