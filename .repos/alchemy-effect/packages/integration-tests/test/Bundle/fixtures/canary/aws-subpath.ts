import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** The same Lambda as `aws-namespace.ts`, importing each service by path. */
export default class CanaryFunction extends Lambda.Function<CanaryFunction>()(
  "CanaryFunction",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("CanaryBucket", {});
    const getObject = yield* S3.GetObject(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.originalUrl).searchParams.get("key") ?? "index";
        const object = yield* getObject({ Key: key });
        return yield* HttpServerResponse.json({ contentLength: object.ContentLength });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(S3.GetObjectHttp)),
) {}
