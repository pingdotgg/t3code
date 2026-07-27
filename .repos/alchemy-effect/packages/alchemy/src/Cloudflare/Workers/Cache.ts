import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  Worker,
  WorkerExecutionContext,
  type CachePurgeError,
} from "./Worker.ts";

export interface CacheOptions {
  /**
   * Whether Workers Cache checks the cache before invoking the Worker.
   * @default true
   */
  enabled?: boolean;
  /**
   * Share cached responses across Worker versions. By default the cache is
   * scoped to a single version, so every deploy starts cold.
   * @default false
   */
  crossVersionCache?: boolean;
}

/**
 * Runtime client for Workers Cache, returned by `yield* Cloudflare.cache()`.
 */
export interface CacheClient {
  /**
   * Purge cached responses by `Cache-Tag`, path prefix, or everything.
   */
  purge(
    options: cf.CachePurgeOptions,
  ): Effect.Effect<cf.CachePurgeResult, CachePurgeError, RuntimeContext>;
}

/**
 * Enable [Workers Cache](https://blog.cloudflare.com/workers-cache/) on the
 * surrounding Worker and get the runtime cache client.
 *
 * Yielding `cache()` in an Effect-native Worker's init phase turns the cache
 * on at deploy time (the equivalent of setting `cache: { enabled: true }` on
 * the Worker's props) and returns a client whose `purge` drives the runtime
 * `ctx.cache` API from your handlers.
 *
 * What gets cached is controlled by standard response headers —
 * `Cache-Control` (including `stale-while-revalidate`), `Cache-Tag` for
 * tag-based purging, and `Vary` for content negotiation.
 *
 * For async (non-Effect) Workers, set the `cache` prop on the Worker
 * instead.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 * @example
 * ```typescript
 * Effect.gen(function* () {
 *   // init: enable Workers Cache on this Worker
 *   const { purge } = yield* Cloudflare.cache();
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const request = yield* HttpServerRequest;
 *       if (request.url.startsWith("/invalidate")) {
 *         yield* purge({ tags: ["products"] });
 *         return HttpServerResponse.text("purged");
 *       }
 *       return HttpServerResponse.text("hello", {
 *         headers: {
 *           "Cache-Control": "public, max-age=300",
 *           "Cache-Tag": "products",
 *         },
 *       });
 *     }),
 *   };
 * })
 * ```
 */
export const cache = (
  options?: CacheOptions,
): Effect.Effect<CacheClient, never, Worker | WorkerExecutionContext> =>
  Effect.gen(function* () {
    const host = yield* Worker;
    const exec = yield* WorkerExecutionContext;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* Namespace.push(
        host.LogicalId,
        host.bind("Cache", {
          cache: {
            enabled: options?.enabled ?? true,
            crossVersionCache: options?.crossVersionCache,
          },
        }),
      );
    }
    return {
      // `exec` is the init-phase deferred context; purge resolves the live
      // per-event context from the calling handler's fiber.
      purge: (purgeOptions) => exec.cache.purge(purgeOptions),
    };
  });
