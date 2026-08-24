import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Fixture worker for `WorkerCache.test.ts` (Effect-native path).
 *
 * `yield* Cloudflare.cache()` in the init phase enables Workers Cache on the
 * Worker (no `cache` prop involved) and returns the runtime purge client.
 * `/item` serves a per-invocation UUID tagged `items`, so a repeated body
 * proves a cache hit and a fresh body after `/purge` proves the tag purge.
 */
export default class CacheTestWorker extends Cloudflare.Worker<CacheTestWorker>()(
  "CacheTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const { purge } = yield* Cloudflare.cache({ crossVersionCache: true });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (url.pathname === "/item") {
          return HttpServerResponse.text(`id:${crypto.randomUUID()}`, {
            headers: {
              "Cache-Control": "public, max-age=300",
              "Cache-Tag": "items",
            },
          });
        }

        if (url.pathname === "/purge") {
          const result = yield* purge({ tags: ["items"] }).pipe(
            Effect.catchTag("CachePurgeError", (error) =>
              Effect.succeed({ success: false, errors: [error.message] }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
