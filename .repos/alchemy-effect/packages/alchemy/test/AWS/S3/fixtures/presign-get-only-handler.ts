import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class PresignGetOnlyTestFunction extends Lambda.Function<PresignGetOnlyTestFunction>()(
  "PresignGetOnlyTestFunction",
) {}

export default PresignGetOnlyTestFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("PresignGetOnlyBucket", {
      forceDestroy: true,
      versioning: "Enabled",
    });
    const presignGet = yield* S3.PresignGetObject(bucket);
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
        return yield* HttpServerResponse.json({
          url: yield* presignGet({
            key,
            versionId: url.searchParams.get("versionId") ?? undefined,
            contentType: url.searchParams.get("contentType") ?? undefined,
            expiresIn: url.searchParams.has("expiresIn")
              ? Number(url.searchParams.get("expiresIn"))
              : undefined,
          }),
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(S3.PresignGetObjectHttp)),
);
