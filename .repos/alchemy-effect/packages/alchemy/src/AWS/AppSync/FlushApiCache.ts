import type * as appsync from "@distilled.cloud/aws/appsync";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * Runtime binding for `appsync:FlushApiCache` — flush a {@link GraphqlApi}'s
 * server-side cache from a Lambda (or other AWS runtime), e.g. after
 * writing to the underlying data store out of band.
 *
 * Fails with the typed `NotFoundException` when the API has no cache
 * provisioned. Provide `AppSync.FlushApiCacheHttp` on the hosting
 * function's Effect to implement the binding.
 *
 * @binding
 * @section Flushing the API Cache
 * @example Invalidate cached resolver results after an out-of-band write
 * ```typescript
 * const flushCache = yield* AppSync.FlushApiCache(api);
 *
 * yield* flushCache().pipe(
 *   // no cache provisioned — nothing to flush
 *   Effect.catchTag("NotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface FlushApiCache extends Binding.Service<
  FlushApiCache,
  "AWS.AppSync.FlushApiCache",
  (
    api: GraphqlApi,
  ) => Effect.Effect<
    () => Effect.Effect<
      appsync.FlushApiCacheResponse,
      appsync.FlushApiCacheError
    >
  >
> {}
export const FlushApiCache = Binding.Service<FlushApiCache>(
  "AWS.AppSync.FlushApiCache",
);
