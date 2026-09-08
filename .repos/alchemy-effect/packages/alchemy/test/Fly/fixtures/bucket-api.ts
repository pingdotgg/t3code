import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const BUCKET_PORT = 3000;
export const OBJECT_KEY = "alchemy-marker.txt";
export const OBJECT_BODY = "hello-from-tigris";

export const BucketSite = Fly.App("BucketSite", {
  enableSubdomains: true,
});

export const Data = Fly.Bucket("Data");

export const BucketIp = Fly.IpAssignment("Shared", {
  app: BucketSite,
  type: "shared_v4",
});

/**
 * HTTP Service that puts and gets an object on a Tigris bucket via
 * the S3 API.
 */
export default class BucketApi extends Fly.Service<BucketApi>()(
  "BucketApi",
  Effect.gen(function* () {
    const bucket = yield* Data;
    return {
      app: BucketSite,
      main: import.meta.url,
      region: "iad",
      port: BUCKET_PORT,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
      env: {
        BUCKET_NAME: bucket.name,
        AWS_ACCESS_KEY_ID: bucket.accessKeyId,
        AWS_SECRET_ACCESS_KEY: bucket.secretAccessKey,
        AWS_ENDPOINT_URL_S3: bucket.endpoint,
        AWS_ENDPOINT_URL: bucket.endpoint,
        AWS_REGION: bucket.region,
      },
    };
  }),
  Effect.gen(function* () {
    const putObject = yield* Fly.PutObject(Data);
    const getObject = yield* Fly.GetObject(Data);

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
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true, key: OBJECT_KEY });
        }

        if (path === "/get") {
          const obj = yield* getObject({ Key: OBJECT_KEY }).pipe(Effect.orDie);
          const text =
            obj.Body === undefined
              ? ""
              : yield* Stream.mkString(Stream.decodeText(obj.Body)).pipe(
                  Effect.orDie,
                );
          return yield* HttpServerResponse.json({
            ok: text === OBJECT_BODY,
            text,
          });
        }

        return yield* HttpServerResponse.json({ ok: false }, { status: 404 });
      }),
    };
  }).pipe(Effect.provide([Fly.PutObjectHttp, Fly.GetObjectHttp])),
) {}
