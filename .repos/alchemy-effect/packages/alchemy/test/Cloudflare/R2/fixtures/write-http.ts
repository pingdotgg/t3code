import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket } from "./bucket.ts";
import { writeRoutes } from "./write-routes.ts";

/** Write-only access via a scoped HTTP API token (`WriteBucketHttp`). */
export default class R2WriteHttpWorker extends Cloudflare.Worker<R2WriteHttpWorker>()(
  "R2WriteHttpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const r2 = yield* Cloudflare.R2.WriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* writeRoutes(r2, request, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.WriteBucketHttp)),
) {}
