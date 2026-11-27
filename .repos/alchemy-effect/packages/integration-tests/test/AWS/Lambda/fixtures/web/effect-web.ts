import * as Lambda from "@alchemy.run/aws/Lambda";
import * as S3 from "@alchemy.run/aws/S3";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export class EffectWebFunction extends Lambda.WebFunction<Lambda.WebFunction>()(
  "EffectWebFunction",
) {}

export default EffectWebFunction.make(
  { main: import.meta.url, authType: "ApplicationManaged" },
  Effect.gen(function* () {
    const bucket = yield* S3.Bucket("WebFunctionBucket", { forceDestroy: true });
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://localhost");

        if (url.pathname === "/stream") {
          // Three chunks 600 ms apart: a buffered bridge would deliver them
          // all at once after ~1.2 s.
          return HttpServerResponse.stream(
            Stream.make("one\n", "two\n", "three\n").pipe(
              Stream.mapEffect((chunk, i) =>
                i === 0 ? Effect.succeed(chunk) : Effect.as(Effect.sleep("600 millis"), chunk),
              ),
              Stream.encodeText,
            ),
            { contentType: "text/plain" },
          );
        }

        if (url.pathname === "/s3") {
          const key = url.searchParams.get("key") ?? "web-function.txt";
          yield* putObject({ Key: key, Body: `written by ${process.env.ALCHEMY_STAGE}` });
          const object = yield* getObject({ Key: key });
          const body = yield* Stream.mkString(Stream.decodeText(object.Body!));
          return yield* HttpServerResponse.json({ key, body });
        }

        if (url.pathname === "/runtime") {
          return yield* HttpServerResponse.json({
            endpoint: process.env.AWS_LAMBDA_HTTP_ENDPOINT,
            requestId: request.headers["lambda-web-request-id"],
            hasCredentials: process.env.AWS_ACCESS_KEY_ID !== undefined,
            region: process.env.AWS_REGION,
          });
        }

        return HttpServerResponse.text("hello from effect");
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(S3.PutObjectHttp, S3.GetObjectHttp))),
);
