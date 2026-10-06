import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** Bucket whose uploads Eventarc routes to the service. */
export const Drops = GCP.Storage.Bucket("EventarcDrops", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});
/** Bucket the service records each event in (unwatched, so no loops). */
export const Markers = GCP.Storage.Bucket("EventarcMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

export const markerFor = (object: string) =>
  `${object.replaceAll("/", "_")}.json`;

/**
 * Effect-native Cloud Run service (default private ingress) receiving
 * Storage finalize events through an Eventarc trigger.
 * Deployed from {@link ../EventSource.test.ts}.
 */
export default class EventarcService extends GCP.Function<EventarcService>()(
  "EventarcService",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const drops = yield* Drops;
    const markers = yield* Markers;
    const putMarker = yield* GCP.Storage.PutObject(markers);

    yield* GCP.Eventarc.consumeEvents(
      "Drops",
      {
        eventFilters: [
          {
            attribute: "type",
            value: "google.cloud.storage.object.v1.finalized",
          },
          { attribute: "bucket", value: drops.bucketName },
        ],
      },
      (event) =>
        Effect.gen(function* () {
          const data = event.data as { name?: string; bucket?: string };
          yield* putMarker({
            name: markerFor(data.name ?? "unknown"),
            body: JSON.stringify({
              id: event.id,
              type: event.type,
              subject: event.subject,
              bucket: data.bucket,
              name: data.name,
            }),
          }).pipe(Effect.orDie);
        }),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(GCP.Storage.PutObjectHttp),
    Effect.provide(GCP.Run.EventarcEventSource),
  ),
) {}
