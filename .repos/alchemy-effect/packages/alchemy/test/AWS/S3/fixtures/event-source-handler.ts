import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Derived writes stay outside the watched prefix to avoid recursive events.
const INCOMING_PREFIX = "incoming/";
const PROCESSED_PREFIX = "processed/";

const recordKey = (key: string, eventName: string, versionId: string) => {
  const path = [key, eventName, versionId].map(encodeURIComponent).join("/");
  return `${PROCESSED_PREFIX}${path}.json`;
};

export class BucketEventSourceFunction extends Lambda.Function<BucketEventSourceFunction>()(
  "BucketEventSourceFunction",
) {}

export default BucketEventSourceFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("EventSourceBucket", {
      forceDestroy: true,
      versioning: "Enabled",
    });

    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    const BucketName = yield* bucket.bucketName;

    yield* S3.consumeBucketEvents(
      bucket,
      {
        events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"],
        prefix: INCOMING_PREFIX,
      },
      (stream) =>
        stream.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const versionId = event.versionId;
              if (!versionId) {
                return yield* Effect.fail(
                  new Error("Versioned bucket notification omitted versionId"),
                );
              }
              const key = yield* Effect.sync(() =>
                recordKey(event.key, event.type, versionId),
              );
              // Redelivery can arrive after the source version was deleted.
              const recorded = yield* getObject({ Key: key }).pipe(
                Effect.flatMap(({ Body }) => Stream.runDrain(Body!)),
                Effect.as(true),
                Effect.catchTag("NoSuchKey", () => Effect.succeed(false)),
              );
              if (recorded) return;
              const object = event.type.startsWith("s3:ObjectCreated:")
                ? yield* getObject({
                    Key: event.key,
                    VersionId: versionId,
                  })
                : undefined;
              const content = object
                ? yield* Stream.mkString(Stream.decodeText(object.Body!))
                : undefined;
              const body = yield* Effect.sync(() =>
                JSON.stringify({
                  bucket: event.bucket,
                  key: event.key,
                  eventName: event.type,
                  versionId,
                  sequencer: event.sequencer,
                  size: event.size,
                  eTag: event.eTag,
                  content,
                  readVersionId: object?.VersionId,
                }),
              );
              yield* putObject({
                Key: key,
                Body: body,
                ContentType: "application/json",
              });
            }).pipe(Effect.orDie),
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bucket-name") {
          // The first event after a cold start can observe not-yet-hydrated
          // resource Outputs — answer 503 so the test retries instead of
          // recording "undefined" as the bucket name.
          const bucketName = yield* BucketName;
          if (!bucketName) {
            return HttpServerResponse.text("Outputs not hydrated yet", {
              status: 503,
            });
          }
          return yield* HttpServerResponse.json({ bucketName });
        }

        if (request.method === "POST" && pathname === "/put") {
          const body = (yield* request.json) as { key: string; value: string };
          const result = yield* putObject({
            Key: `${INCOMING_PREFIX}${body.key}`,
            Body: body.value,
            ContentType: "text/plain",
          });
          return yield* HttpServerResponse.json({
            ok: true,
            versionId: result.VersionId,
          });
        }

        if (request.method === "GET" && pathname === "/processed") {
          const key = url.searchParams.get("key");
          const eventName = url.searchParams.get("eventName");
          const versionId = url.searchParams.get("versionId");
          if (!key || !eventName || !versionId) {
            return HttpServerResponse.text(
              "Missing key, eventName, or versionId",
              { status: 400 },
            );
          }
          const storedKey = yield* Effect.sync(() =>
            recordKey(key, eventName, versionId),
          );
          return yield* getObject({ Key: storedKey }).pipe(
            Effect.flatMap((result) =>
              Stream.mkString(Stream.decodeText(result.Body!)),
            ),
            Effect.flatMap((text) => Effect.try(() => JSON.parse(text))),
            Effect.flatMap((processed) =>
              HttpServerResponse.json({ processed }),
            ),
            // Object not written yet — the test polls until it appears.
            Effect.catchTag("NoSuchKey", () =>
              HttpServerResponse.json({ processed: null }, { status: 404 }),
            ),
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.BucketEventSource,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);
