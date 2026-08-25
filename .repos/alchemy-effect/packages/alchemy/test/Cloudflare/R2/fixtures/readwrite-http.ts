import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket } from "./bucket.ts";
import { readRoutes } from "./read-routes.ts";
import { writeRoutes } from "./write-routes.ts";

/** Read + write access via a scoped HTTP API token (`ReadWriteBucketHttp`). */
export default class R2ReadWriteHttpWorker extends Cloudflare.Worker<R2ReadWriteHttpWorker>()(
  "R2ReadWriteHttpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const r2 = yield* Cloudflare.R2.ReadWriteBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        // The ReadWrite client composes both halves; route to whichever
        // matches so we exercise read *and* write through one client.
        const handled =
          (yield* writeRoutes(r2, request, url)) ??
          (yield* readRoutes(r2, url));
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketHttp)),
) {}
