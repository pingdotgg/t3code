import * as Cloudflare from "@/Cloudflare/index.ts";
import type { Bucket } from "@/Cloudflare/R2/Bucket.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Shared Worker implementation for the presign fixtures: mints presigned
 * URLs for `bucket` and exposes the native binding so the test can verify
 * that uploads through a presigned URL land in the same bucket.
 *
 * - `GET /presign-put?key=&contentType=` → `{ url }`
 * - `GET /presign-get?key=&contentType=` → `{ url }`
 * - `GET /read?key=` → `{ value, contentType }` via the native binding
 * - `PUT /write?key=` → writes the body via the native binding
 */
export const presignWorker = (bucket: Effect.Effect<Bucket, never, any>) =>
  Effect.gen(function* () {
    const b = yield* bucket;
    const presignPut = yield* Cloudflare.R2.PresignPutObject(b);
    const presignGet = yield* Cloudflare.R2.PresignGetObject(b);
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(b);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const key = url.searchParams.get("key") ?? "";
        const contentType = url.searchParams.get("contentType") ?? undefined;
        switch (url.pathname) {
          case "/presign-put":
            return yield* HttpServerResponse.json({
              url: yield* presignPut({ key, contentType }).pipe(Effect.orDie),
            });
          case "/presign-get":
            return yield* HttpServerResponse.json({
              url: yield* presignGet({ key, contentType }).pipe(Effect.orDie),
            });
          case "/read": {
            const object = yield* r2.get(key).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({
              value:
                object === null
                  ? null
                  : yield* object.text().pipe(Effect.orDie),
              contentType: object?.httpMetadata?.contentType ?? null,
            });
          }
          case "/write": {
            const body = yield* request.text.pipe(Effect.orDie);
            yield* r2.put(key, body).pipe(Effect.orDie);
            return HttpServerResponse.text("ok");
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.R2.PresignPutObjectToken),
    Effect.provide(Cloudflare.R2.PresignGetObjectToken),
    Effect.provide(Cloudflare.R2.ReadWriteBucketBinding),
  );
