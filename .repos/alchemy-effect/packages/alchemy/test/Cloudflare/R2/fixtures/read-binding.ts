import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestBucket } from "./bucket.ts";
import { readRoutes } from "./read-routes.ts";

/** Read-only access via the native Worker binding (`ReadBucketBinding`). */
export default class R2ReadBindingWorker extends Cloudflare.Worker<R2ReadBindingWorker>()(
  "R2ReadBindingWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* TestBucket;
    const r2 = yield* Cloudflare.R2.ReadBucket(bucket);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* readRoutes(r2, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadBucketBinding)),
) {}
