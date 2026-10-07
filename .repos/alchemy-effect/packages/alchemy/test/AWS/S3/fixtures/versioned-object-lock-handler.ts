import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class S3VersionedObjectLockFunction extends Lambda.Function<S3VersionedObjectLockFunction>()(
  "S3VersionedObjectLockFunction",
) {}

const versionRequest = Schema.Struct({
  Key: Schema.String,
  VersionId: Schema.optional(Schema.String),
});

export default S3VersionedObjectLockFunction.make(
  {
    main: import.meta.url,
    functionUrl: true,
    timeout: Duration.seconds(30),
    memorySize: 512,
  },
  Effect.gen(function* () {
    const props = {
      versioning: "Enabled",
      objectLockEnabled: true,
      forceDestroy: true,
    } as const;
    const buckets = {
      GetObjectRetention: yield* S3.Bucket(
        "VersionedObjectLockGetRetentionBucket",
        props,
      ),
      PutObjectRetention: yield* S3.Bucket(
        "VersionedObjectLockPutRetentionBucket",
        props,
      ),
      GetObjectLegalHold: yield* S3.Bucket(
        "VersionedObjectLockGetHoldBucket",
        props,
      ),
      PutObjectLegalHold: yield* S3.Bucket(
        "VersionedObjectLockPutHoldBucket",
        props,
      ),
      RestoreObject: yield* S3.Bucket("VersionedObjectLockRestoreBucket", {
        versioning: "Enabled",
        forceDestroy: true,
      }),
    };
    const getRetention = yield* S3.GetObjectRetention(
      buckets.GetObjectRetention,
    );
    const putRetention = yield* S3.PutObjectRetention(
      buckets.PutObjectRetention,
    );
    const getHold = yield* S3.GetObjectLegalHold(buckets.GetObjectLegalHold);
    const putHold = yield* S3.PutObjectLegalHold(buckets.PutObjectLegalHold);
    const restore = yield* S3.RestoreObject(buckets.RestoreObject);
    const info = yield* Effect.forEach(
      Object.entries(buckets),
      ([binding, bucket]) =>
        Effect.gen(function* () {
          return {
            binding,
            bucketName: yield* bucket.bucketName,
            bucketArn: yield* bucket.bucketArn,
          };
        }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        if (url.pathname === "/info") {
          const resolved = yield* Effect.forEach(info, (bucket) =>
            Effect.gen(function* () {
              return {
                binding: bucket.binding,
                bucketName: yield* bucket.bucketName,
                bucketArn: yield* bucket.bucketArn,
              };
            }),
          );
          if (
            resolved.some((bucket) => !bucket.bucketName || !bucket.bucketArn)
          ) {
            return HttpServerResponse.text("Outputs not hydrated yet", {
              status: 503,
            });
          }
          return yield* HttpServerResponse.json(resolved);
        }
        if (request.method !== "POST") {
          return HttpServerResponse.text("Use POST", { status: 405 });
        }
        const body = yield* request.json;
        switch (url.pathname) {
          case "/get-retention": {
            const input =
              yield* Schema.decodeUnknownEffect(versionRequest)(body);
            return yield* HttpServerResponse.json(yield* getRetention(input));
          }
          case "/put-retention": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                Key: Schema.String,
                VersionId: Schema.String,
                retainUntil: Schema.String,
              }),
            )(body);
            const RetainUntilDate = yield* Effect.sync(
              () => new Date(input.retainUntil),
            );
            yield* putRetention({
              Key: input.Key,
              VersionId: input.VersionId,
              Retention: { Mode: "GOVERNANCE", RetainUntilDate },
            });
            return yield* HttpServerResponse.json({ retained: true });
          }
          case "/get-hold": {
            const input =
              yield* Schema.decodeUnknownEffect(versionRequest)(body);
            return yield* HttpServerResponse.json(yield* getHold(input));
          }
          case "/put-hold": {
            const input = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                Key: Schema.String,
                VersionId: Schema.String,
                Status: Schema.Literals(["ON", "OFF"]),
              }),
            )(body);
            yield* putHold({
              Key: input.Key,
              VersionId: input.VersionId,
              LegalHold: { Status: input.Status },
            });
            return yield* HttpServerResponse.json({ updated: true });
          }
          case "/restore": {
            const input =
              yield* Schema.decodeUnknownEffect(versionRequest)(body);
            const result = yield* restore({
              ...input,
              RestoreRequest: {
                Days: 1,
                GlacierJobParameters: { Tier: "Standard" },
              },
            }).pipe(
              Effect.as({ tag: "accepted", versionId: input.VersionId }),
              Effect.catchTag("InvalidObjectState", () =>
                Effect.succeed({ tag: "InvalidObjectState" }),
              ),
            );
            return yield* HttpServerResponse.json(result);
          }
          default:
            return HttpServerResponse.text("Not found", { status: 404 });
        }
      }).pipe(
        Effect.catchTag(
          [
            "NoSuchVersion",
            "NoSuchKey",
            "MethodNotAllowed",
            "InvalidRequest",
            "AccessDeniedException",
          ],
          (error) =>
            HttpServerResponse.json(
              { tag: error._tag },
              {
                status:
                  error._tag === "MethodNotAllowed"
                    ? 405
                    : error._tag === "InvalidRequest"
                      ? 400
                      : error._tag === "AccessDeniedException"
                        ? 403
                        : 404,
              },
            ),
        ),
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        S3.GetObjectRetentionHttp,
        S3.PutObjectRetentionHttp,
        S3.GetObjectLegalHoldHttp,
        S3.PutObjectLegalHoldHttp,
        S3.RestoreObjectHttp,
      ),
    ),
  ),
);
