import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  documentFor,
  Files,
  UPLOADS_PREFIX,
  Uploads,
  type FileRecord,
} from "./resources.ts";

const sha256Hex = (bytes: Uint8Array) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    ),
  );

/**
 * The background half of the pipeline: index every finished upload.
 *
 * Cloud Storage publishes an `OBJECT_FINALIZE` notification for each
 * object written under `uploads/`; Pub/Sub pushes it to this service,
 * which reads the object back, hashes it, and records the result in
 * Firestore. Nothing here runs on the upload's request path, so a slow
 * hash of a large file never delays the client.
 *
 * The service stays private: Pub/Sub authenticates each push with an
 * OIDC token for the service's own identity.
 */
export default class Indexer extends GCP.Function<Indexer>()(
  "Indexer",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const bucket = yield* Uploads;
    const database = yield* Files;

    const uploads = yield* GCP.Storage.ReadBucket(bucket);
    const files = yield* GCP.Firestore.WriteDatabase(database);

    yield* GCP.Storage.consumeBucketEvents(
      bucket,
      { eventTypes: ["OBJECT_FINALIZE"], prefix: UPLOADS_PREFIX },
      (events) =>
        events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              // Read the exact generation the event describes. If it has
              // since been overwritten or deleted, a later event (or the
              // delete) owns the record, so there is nothing to do.
              const object = yield* uploads.get(event.object, {
                generation: event.generation,
              });
              if (object === undefined) {
                yield* Effect.log(`indexer: ${event.object} is gone, skipping`);
                return;
              }

              const name = event.object.slice(UPLOADS_PREFIX.length);
              const record: FileRecord = {
                name,
                object: event.object,
                generation: event.generation,
                size: object.body.byteLength,
                contentType:
                  object.contentType ??
                  event.metadata.contentType ??
                  "application/octet-stream",
                sha256: yield* sha256Hex(object.body),
                indexedAt: new Date(),
              };

              yield* files.set(documentFor(name), { ...record });
              yield* Effect.log(`indexer: ${name} (${record.size} bytes)`);
            }).pipe(
              // A failure fails the push, so Pub/Sub redelivers the event.
              Effect.orDie,
            ),
          ),
        ),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([
      GCP.Storage.BucketEventSourceLive,
      GCP.Storage.ReadBucketHttp,
      GCP.Firestore.WriteDatabaseHttp,
    ]),
    Effect.provide(GCP.Run.TopicEventSource),
  ),
) {}
