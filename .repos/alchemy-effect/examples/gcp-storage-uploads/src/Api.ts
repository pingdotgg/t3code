import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  documentFor,
  Files,
  isValidName,
  objectFor,
  Uploads,
} from "./resources.ts";

/**
 * The front door of an upload pipeline.
 *
 * Uploads go straight to Cloud Storage; this service never computes
 * anything about them. The {@link ../Indexer.ts Indexer} picks each one
 * up from the bucket's notification and writes the metadata that
 * `GET /files` serves.
 *
 * - `PUT /files/:name` — store the request body at `uploads/:name`.
 * - `GET /files/:name` — return the stored bytes.
 * - `GET /files` — list the indexed metadata from Firestore.
 * - `DELETE /files/:name` — delete the object and its metadata.
 *
 * `invokerIamDisabled: true` makes the service public. Put real
 * authentication in front of it before storing anything that matters.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const bucket = yield* Uploads;
    const database = yield* Files;

    // Least privilege per verb: objectViewer to read, objectUser to write
    // (overwriting an object needs delete, which objectCreator lacks).
    const reader = yield* GCP.Storage.ReadBucket(bucket);
    const writer = yield* GCP.Storage.WriteBucket(bucket);
    // Listing metadata and removing it on delete.
    const files = yield* GCP.Firestore.ReadWriteDatabase(database);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (
          request.method === "GET" &&
          segments.length === 1 &&
          segments[0] === "files"
        ) {
          const { documents } = yield* files
            .list("files", { pageSize: 100 })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            files: documents.map((document) => document.fields),
          });
        }

        if (segments.length !== 2 || segments[0] !== "files") {
          return yield* HttpServerResponse.json(
            { error: "not found" },
            { status: 404 },
          );
        }

        const name = decodeURIComponent(segments[1]!);
        if (!isValidName(name)) {
          return yield* HttpServerResponse.json(
            { error: "names are 1-128 characters of [A-Za-z0-9._-]" },
            { status: 400 },
          );
        }

        if (request.method === "PUT") {
          const body = new Uint8Array(yield* request.arrayBuffer);
          const object = yield* writer
            .put(objectFor(name), body, {
              contentType:
                request.headers["content-type"] ?? "application/octet-stream",
            })
            .pipe(Effect.orDie);
          // 202: the bytes are stored, the metadata follows asynchronously.
          return yield* HttpServerResponse.json(
            {
              name,
              object: object.name,
              generation: object.generation,
              size: Number(object.size ?? body.byteLength),
            },
            { status: 202 },
          );
        }

        if (request.method === "GET") {
          const object = yield* reader.get(objectFor(name)).pipe(Effect.orDie);
          if (object === undefined) {
            return yield* HttpServerResponse.json(
              { error: "no such file" },
              { status: 404 },
            );
          }
          return HttpServerResponse.uint8Array(object.body, {
            contentType: object.contentType ?? "application/octet-stream",
          });
        }

        if (request.method === "DELETE") {
          yield* writer.delete(objectFor(name)).pipe(Effect.orDie);
          yield* files.delete(documentFor(name)).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }

        return yield* HttpServerResponse.json(
          { error: "method not allowed" },
          { status: 405 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.Storage.ReadBucketHttp,
      GCP.Storage.WriteBucketHttp,
      GCP.Firestore.ReadWriteDatabaseHttp,
    ]),
  ),
) {}
