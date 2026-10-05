import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  docId,
  Jobs,
  SCHEDULE_BODY,
  SCHEDULE_ID,
  Store,
  Uploads,
  type JobMessage,
} from "./serverless-resources.ts";

/**
 * Private worker Function (no public invoker) with three event sources:
 *
 * - Pub/Sub push from {@link Jobs} → `results/{id}`
 * - Cloud Scheduler job {@link SCHEDULE_ID} → `schedules/{jobName}`
 * - Eventarc Storage finalize on {@link Uploads} → `uploads/{object}`
 *
 * Every delivery is authenticated with an OIDC token for the worker's own
 * service account.
 */
export default class SmokeWorker extends GCP.Function<SmokeWorker>()(
  "SmokeWorker",
  { main: import.meta.url, location: "us-central1" },
  Effect.gen(function* () {
    const uploads = yield* Uploads;
    const store = yield* GCP.Firestore.WriteDatabase(Store);

    yield* GCP.PubSub.consumeTopicMessages(Jobs, (messages) =>
      messages.pipe(
        Stream.runForEach(({ message }) =>
          Effect.gen(function* () {
            const job = yield* Effect.try(
              () =>
                JSON.parse(
                  Buffer.from(message.data ?? "", "base64").toString("utf8"),
                ) as JobMessage,
            );
            yield* store.set(`results/${job.id}`, {
              id: job.id,
              payload: job.payload,
              processed: job.payload.toUpperCase(),
              messageId: message.messageId,
            });
          }),
        ),
        Effect.orDie,
      ),
    );

    yield* GCP.CloudScheduler.consumeSchedule(
      SCHEDULE_ID,
      { schedule: "0 0 1 1 *", timeZone: "Etc/UTC", body: SCHEDULE_BODY },
      (event) =>
        store
          .set(`schedules/${docId(event.jobName)}`, {
            jobName: event.jobName,
            body: event.body ?? null,
            scheduleTime: event.scheduleTime ?? null,
          })
          .pipe(Effect.asVoid, Effect.orDie),
    );

    yield* GCP.Eventarc.consumeEvents(
      "SmokeUploads",
      {
        eventFilters: [
          {
            attribute: "type",
            value: "google.cloud.storage.object.v1.finalized",
          },
          { attribute: "bucket", value: uploads.bucketName },
        ],
      },
      (event) =>
        Effect.gen(function* () {
          const data = event.data as { name?: string; bucket?: string };
          yield* store.set(`uploads/${docId(data.name ?? "unknown")}`, {
            id: event.id,
            type: event.type,
            bucket: data.bucket ?? null,
            name: data.name ?? null,
          });
        }).pipe(Effect.orDie),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(GCP.Firestore.WriteDatabaseHttp),
    Effect.provide(GCP.Run.TopicEventSource),
    Effect.provide(GCP.Run.ScheduleEventSource),
    Effect.provide(GCP.Run.EventarcEventSource),
  ),
) {}
