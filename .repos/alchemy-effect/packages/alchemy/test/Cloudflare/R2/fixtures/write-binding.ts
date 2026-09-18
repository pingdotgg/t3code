import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket } from "./bucket.ts";
import { writeRoutes } from "./write-routes.ts";

/** Write-only access via the native Worker binding (`WriteBucketBinding`). */
export default class R2WriteBindingWorker extends Cloudflare.Worker<R2WriteBindingWorker>()(
  "R2WriteBindingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const r2 = yield* Cloudflare.R2.WriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        // `PUT /put-stream?key=&sha256=` — `put(key, stream, { contentLength,
        // sha256 })`: the body reaches R2 as an Effect `Stream`, and R2 must
        // verify it against the declared hash. Only the native binding can
        // stream, so this route is not part of the shared write routes.
        if (request.method === "PUT" && url.pathname === "/put-stream") {
          const key = url.searchParams.get("key") ?? "";
          const sha256 = url.searchParams.get("sha256") ?? "";
          const contentLength = Number(request.headers["content-length"] ?? 0);
          return yield* r2
            .put(key, request.stream, { contentLength, sha256 })
            .pipe(
              Effect.flatMap((object) =>
                HttpServerResponse.json({
                  stored: true,
                  size: object?.size ?? null,
                }),
              ),
              Effect.catchTag("R2Error", (e) =>
                HttpServerResponse.json(
                  { stored: false, error: e.message },
                  { status: 400 },
                ),
              ),
            );
        }
        const handled = yield* writeRoutes(r2, request, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.WriteBucketBinding)),
) {}
