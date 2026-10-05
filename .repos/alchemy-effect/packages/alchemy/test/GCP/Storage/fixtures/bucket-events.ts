import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const INCOMING_PREFIX = "incoming/";

/** Marker object the consumer writes for one delivered event. */
export const markerFor = (object: string) =>
  `markers/${object.replaceAll("/", "_")}.json`;

/** Bucket whose `incoming/` uploads trigger the consumer. */
export const Uploads = GCP.Storage.Bucket("Uploads", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/**
 * Effect-native Cloud Run service that consumes `incoming/` finalize events
 * over Pub/Sub push and records each one as a marker object in the same
 * bucket (outside the notification prefix, so markers don't re-trigger).
 * Deployed from {@link ../BucketEventSource.test.ts}.
 */
export default class BucketEventsService extends GCP.Function<BucketEventsService>()(
  "BucketEventsService",
  {
    main: import.meta.url,
    location: "us-central1",
  },
  Effect.gen(function* () {
    const bucket = yield* Uploads;
    const putObject = yield* GCP.Storage.PutObject(bucket);

    yield* GCP.Storage.consumeBucketEvents(
      bucket,
      { prefix: INCOMING_PREFIX },
      (events) =>
        events.pipe(
          Stream.runForEach((event) =>
            putObject({
              name: markerFor(event.object),
              body: JSON.stringify({
                eventType: event.eventType,
                bucket: event.bucket,
                object: event.object,
                generation: event.generation,
                eventTime: event.eventTime,
                size: event.metadata.size,
                contentType: event.metadata.contentType,
              }),
            }).pipe(Effect.orDie),
          ),
        ),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide(GCP.Storage.BucketEventSourceLive),
    Effect.provide(GCP.Run.TopicEventSource),
    Effect.provide(GCP.Storage.PutObjectHttp),
  ),
) {}
