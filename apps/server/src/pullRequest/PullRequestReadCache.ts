import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";
import * as Persistable from "effect/unstable/persistence/Persistable";
import * as PersistedCache from "effect/unstable/persistence/PersistedCache";
import * as Persistence from "effect/unstable/persistence/Persistence";
import { ServerConfig } from "../config.ts";

const CONCURRENT_READS = 512;
type ReadError = PullRequestOperationError | PullRequestUnavailableError;

class Read extends Persistable.Class<{
  payload: { key: string; lookup: Effect.Effect<string, ReadError> };
}>()("PullRequestRead", {
  primaryKey: ({ key }) => key,
  success: Schema.Struct({ payload: Schema.String, expiresAt: Schema.Finite }),
  error: Schema.Union([PullRequestOperationError, PullRequestUnavailableError]),
}) {
  [Equal.symbol](that: unknown): boolean {
    return that instanceof Read && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

export class PullRequestReadCache extends Context.Service<
  PullRequestReadCache,
  {
    readonly get: (
      key: string,
      lookup: Effect.Effect<string, ReadError>,
    ) => Effect.Effect<string, ReadError>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestReadCache") {}

export const make = Effect.gen(function* () {
  const backing = yield* KeyValueStore.KeyValueStore;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  let enabled = true;
  const lock = yield* Semaphore.make(CONCURRENT_READS);
  const timeToLive: Persistable.TimeToLiveFn<Read> = (exit) =>
    Exit.isSuccess(exit)
      ? Duration.millis(Math.max(0, exit.value.expiresAt - clock.currentTimeMillisUnsafe()))
      : Duration.zero;
  const cache = yield* PersistedCache.make(
    (request: Read) =>
      request.lookup.pipe(
        Effect.map((payload) => ({ payload, expiresAt: clock.currentTimeMillisUnsafe() + 60_000 })),
      ),
    {
      storeId: "pr-v2",
      timeToLive,
      inMemoryTTL: timeToLive,
      inMemoryCapacity: CONCURRENT_READS,
    },
  );
  return PullRequestReadCache.of({
    get: Effect.fn("PullRequestReadCache.get")(function* (key, lookup) {
      if (!enabled) return yield* lookup;
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(key))
        .pipe(Effect.option);
      if (Option.isNone(digest)) return yield* lookup;
      const read = yield* Effect.cached(lookup);
      return yield* cache
        .get(new Read({ key: Encoding.encodeHex(digest.value), lookup: read }))
        .pipe(
          Effect.map((result) => result.payload),
          Effect.catchTags({
            PersistenceError: () => read,
            SchemaError: () => read,
          }),
          Effect.uninterruptible,
          lock.withPermits(1),
        );
    }),
    // Let existing reads finish before clearing, so they cannot repopulate stale entries.
    invalidate: Cache.invalidateAll(cache.inMemory).pipe(
      Effect.andThen(backing.clear),
      Effect.catch(() => {
        enabled = false;
        return Effect.logWarning("PR cache disabled after clearing failed");
      }),
      lock.withPermits(CONCURRENT_READS),
    ),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(PullRequestReadCache, make).pipe(
      Layer.provide(Persistence.layerKvs),
      Layer.provide(
        KeyValueStore.layerFileSystem(
          path.join(config.providerStatusCacheDir, "pull-requests"),
        ).pipe(
          Layer.catch(() =>
            Layer.effectDiscard(
              Effect.logWarning("PR cache directory unavailable; using memory cache"),
            ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
