import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/** A Lambda that reaches the AWS package through `import * as AWS`. */
export default class CanaryFunction extends AWS.Lambda.Function<CanaryFunction>()(
  "CanaryFunction",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("CanaryBucket", {});
    const getObject = yield* AWS.S3.GetObject(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.originalUrl).searchParams.get("key") ?? "index";
        const object = yield* getObject({ Key: key });
        return yield* HttpServerResponse.json({ contentLength: object.ContentLength });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(AWS.S3.GetObjectHttp)),
) {}
