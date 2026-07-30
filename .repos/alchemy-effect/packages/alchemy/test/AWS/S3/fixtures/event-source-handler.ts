import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Keys written by the `fetch` route live under `incoming/`; the subscription
// only listens to that prefix and writes its derived object under `processed/`.
// Without the prefix filter the `processed/` write would itself trigger the
// subscription, which writes another object, and so on — a runaway train.
const INCOMING_PREFIX = "incoming/";
const PROCESSED_PREFIX = "processed/";

export class BucketEventSourceFunction extends Lambda.Function<BucketEventSourceFunction>()(
  "BucketEventSourceFunction",
) {}

export default BucketEventSourceFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("EventSourceBucket", {
      forceDestroy: true,
    });

    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    const BucketName = yield* bucket.bucketName;

    // Subscribe to object-created events under `incoming/`. Each notification
    // writes a derived object under `processed/<name>` recording the event.
    yield* S3.consumeBucketEvents(
      bucket,
      {
        events: ["s3:ObjectCreated:*"],
        prefix: INCOMING_PREFIX,
      },
      (stream) =>
        stream.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const name = event.key.slice(INCOMING_PREFIX.length);
              yield* putObject({
                Key: `${PROCESSED_PREFIX}${name}`,
                Body: JSON.stringify({
                  key: event.key,
                  size: event.size,
                  eTag: event.eTag,
                }),
                ContentType: "application/json",
              });
            }).pipe(Effect.orDie),
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
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
          yield* putObject({
            Key: `${INCOMING_PREFIX}${body.key}`,
            Body: body.value,
            ContentType: "text/plain",
          });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/processed") {
          const key = url.searchParams.get("key");
          if (!key) {
            return HttpServerResponse.text("Missing key", { status: 400 });
          }
          return yield* getObject({ Key: `${PROCESSED_PREFIX}${key}` }).pipe(
            Effect.flatMap((result) =>
              Stream.mkString(Stream.decodeText(result.Body!)),
            ),
            Effect.flatMap((text) =>
              HttpServerResponse.json({ processed: JSON.parse(text) }),
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
