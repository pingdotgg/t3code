import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const SCHEDULE_ID = "Heartbeat";
export const SCHEDULE_BODY = "hello-scheduler";

/** Marker object the consumer writes for one scheduled run. */
export const markerFor = (jobName: string) => `markers/${jobName}.json`;

/** Bucket the consumer records runs in. */
export const Markers = GCP.Storage.Bucket("ScheduleMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

/**
 * Effect-native Cloud Run service that consumes a (yearly, so never
 * naturally firing during a test) Cloud Scheduler job and records each run
 * as a marker object. Deployed from {@link ../ScheduleEventSource.test.ts}.
 */
export default class ScheduleService extends GCP.Function<ScheduleService>()(
  "ScheduleService",
  {
    main: import.meta.url,
    location: "us-central1",
  },
  Effect.gen(function* () {
    const bucket = yield* Markers;
    const putObject = yield* GCP.Storage.PutObject(bucket);

    yield* GCP.CloudScheduler.consumeSchedule(
      SCHEDULE_ID,
      { schedule: "0 0 1 1 *", timeZone: "Etc/UTC", body: SCHEDULE_BODY },
      (event) =>
        putObject({
          name: markerFor(event.jobName),
          body: JSON.stringify(event),
        }).pipe(Effect.asVoid, Effect.orDie),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide(GCP.Run.ScheduleEventSource),
    Effect.provide(GCP.Storage.PutObjectHttp),
  ),
) {}
