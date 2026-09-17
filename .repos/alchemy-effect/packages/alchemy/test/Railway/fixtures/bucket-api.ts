import * as Railway from "@/Railway";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Partition, Site } from "./suite-env.ts";

export { Site };

export const BUCKET_PORT = 3000;
export const OBJECT_KEY = "alchemy-marker.txt";
export const OBJECT_BODY = "hello-from-railway";

export const Data = Railway.Bucket("Data", {
  project: Site,
  environment: Partition,
});

/**
 * HTTP Service that puts and gets an object on a Railway bucket via
 * the S3 API.
 */
export default class BucketApi extends Railway.Service<BucketApi>()(
  "BucketApi",
  Effect.gen(function* () {
    const bucket = yield* Data;
    return {
      project: Site,
      environment: Partition,
      main: import.meta.url,
      port: BUCKET_PORT,
      env: {
        BUCKET_NAME: bucket.s3BucketName,
        AWS_ACCESS_KEY_ID: bucket.accessKeyId,
        AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
        AWS_ENDPOINT_URL_S3: bucket.endpoint,
        AWS_ENDPOINT_URL: bucket.endpoint,
        AWS_REGION: bucket.s3Region,
      },
    };
  }),
  Effect.gen(function* () {
    const putObject = yield* Railway.PutObject(Data);
    const getObject = yield* Railway.GetObject(Data);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;

        if (path === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (path === "/put") {
          yield* putObject({
            Key: OBJECT_KEY,
            Body: OBJECT_BODY,
            ContentType: "text/plain",
          });
          return yield* HttpServerResponse.json({ ok: true, key: OBJECT_KEY });
        }

        if (path === "/get") {
          const obj = yield* getObject({ Key: OBJECT_KEY });
          const text =
            obj.Body === undefined
              ? ""
              : yield* Stream.mkString(Stream.decodeText(obj.Body));
          return yield* HttpServerResponse.json({
            ok: text === OBJECT_BODY,
            text,
          });
        }

        return yield* HttpServerResponse.json({ ok: false }, { status: 404 });
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide([Railway.PutObjectHttp, Railway.GetObjectHttp])),
) {}
