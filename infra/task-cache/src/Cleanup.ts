import * as Effect from "effect/Effect";
import * as Cache from "./Cache.ts";

export const batchSize = 256;

export const run = Effect.fn("TaskCache.cleanup")(function* () {
  const cache = yield* Cache.Cache;
  // Three full batches stay below D1’s 1,000-query invocation limit.
  yield* Effect.all([cache.cleanup, cache.cleanup, cache.cleanup], {
    concurrency: 3,
    discard: true,
  });
});
