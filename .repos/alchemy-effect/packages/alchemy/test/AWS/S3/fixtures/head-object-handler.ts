import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class HeadObjectTestFunction extends Lambda.Function<HeadObjectTestFunction>()(
  "HeadObjectTestFunction",
) {}

export default HeadObjectTestFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("HeadObjectBucket", {
      forceDestroy: true,
      versioning: "Enabled",
    });
    const headObject = yield* S3.HeadObject(bucket);
    const bucketName = yield* bucket.bucketName;
    const bucketArn = yield* bucket.bucketArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));
        if (url.pathname === "/info") {
          return yield* HttpServerResponse.json({
            bucketName: yield* bucketName,
            bucketArn: yield* bucketArn,
          });
        }
        const key = url.searchParams.get("key");
        if (!key)
          return HttpServerResponse.text("Missing key", { status: 400 });
        return yield* headObject({
          Key: key,
          VersionId: url.searchParams.get("versionId") ?? undefined,
        }).pipe(
          Effect.flatMap((result) =>
            HttpServerResponse.json({
              contentLength: result.ContentLength,
              contentType: result.ContentType,
              versionId: result.VersionId,
            }),
          ),
          Effect.catchTag("NotFound", () =>
            HttpServerResponse.json({ tag: "NotFound" }, { status: 404 }),
          ),
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(S3.HeadObjectHttp)),
);
