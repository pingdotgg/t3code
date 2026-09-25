import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Encoding from "effect/Encoding";
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
const revisionCodec = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({ revision: Schema.String, expiresAt: Schema.Finite }),
  ),
);
class Read extends Persistable.Class<{
  payload: { key: string; revision: string; lookup: Effect.Effect<string, ReadError> };
}>()("PullRequestRead", {
  primaryKey: ({ key }) => key,
  success: Schema.Struct({
    payload: Schema.String,
    expiresAt: Schema.Finite,
    revision: Schema.optionalKey(Schema.String),
  }),
  error: Schema.Union([PullRequestOperationError, PullRequestUnavailableError]),
}) {
  matchesRevision(revision: string | undefined): boolean {
    const stored = revision?.split(":") ?? [];
    return this.revision
      .split(":")
      .every((value, index) => value === "" || value === stored[index]);
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof Read && that.key === this.key && that.revision === this.revision;
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.key}:${this.revision}`);
  }
}

export class PullRequestReadCache extends Context.Service<
  PullRequestReadCache,
  {
    readonly get: (
      key: string,
      lookup: Effect.Effect<string, ReadError>,
      scopes?: ReadonlyArray<string>,
    ) => Effect.Effect<string, ReadError>;
    readonly invalidate: (scope: string) => Effect.Effect<void>;
  }
>()("t3/pullRequest/PullRequestReadCache") {}

export const make = Effect.gen(function* () {
  const backing = yield* KeyValueStore.KeyValueStore;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* Clock.Clock;
  let enabled = true;
  const lock = yield* Semaphore.make(CONCURRENT_READS);
  const digest = (key: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(key)).pipe(Effect.map(Encoding.encodeHex));
  const revisions = yield* Cache.makeWith(
    () =>
      backing
        .get("revisions")
        .pipe(Effect.flatMap((raw) => Schema.decodeEffect(revisionCodec)(raw ?? "{}"))),
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );
  const timeToLive: Persistable.TimeToLiveFn<Read> = (exit) =>
    Exit.isSuccess(exit)
      ? Duration.millis(Math.max(0, exit.value.expiresAt - clock.currentTimeMillisUnsafe()))
      : Duration.zero;
  const cache = yield* PersistedCache.make(
    (request: Read) =>
      request.lookup.pipe(
        Effect.map((payload) => ({
          payload,
          expiresAt: clock.currentTimeMillisUnsafe() + 60_000,
          revision: request.revision,
        })),
      ),
    {
      storeId: "pr-v2",
      timeToLive,
      inMemoryTTL: timeToLive,
      inMemoryCapacity: CONCURRENT_READS,
    },
  ).pipe(Effect.provide(Persistence.layerKvs));
  const refreshes = yield* Cache.makeWith(
    Effect.fn("PullRequestReadCache.refresh")(function* (request: Read) {
      const stored = yield* cache.get(request);
      if (request.matchesRevision(stored.revision)) return stored;
      yield* cache.invalidate(request);
      return yield* cache.get(request);
    }),
    { capacity: CONCURRENT_READS, timeToLive: () => Duration.zero },
  );
  return PullRequestReadCache.of({
    get: Effect.fn("PullRequestReadCache.get")(function* (key, lookup, scopes = []) {
      if (!enabled) return yield* lookup;
      const read = yield* Effect.cached(lookup);
      return yield* Effect.gen(function* () {
        const current = yield* Cache.get(revisions, undefined);
        const now = clock.currentTimeMillisUnsafe();
        const revision = scopes
          .map((scope) => {
            const value = current[scope];
            return value !== undefined && value.expiresAt > now ? value.revision : "";
          })
          .join(":");
        const request = new Read({ key: yield* digest(key), revision, lookup: read });
        const stored = yield* cache.get(request);
        return (
          request.matchesRevision(stored.revision) ? stored : yield* Cache.get(refreshes, request)
        ).payload;
      }).pipe(
        Effect.catchTags({
          PlatformError: () => read,
          KeyValueStoreError: () => read,
          PersistenceError: () => read,
          SchemaError: () => read,
        }),
        lock.withPermits(1),
      );
    }),
    invalidate: (scope) =>
      Effect.gen(function* () {
        const now = clock.currentTimeMillisUnsafe();
        const current = yield* Cache.get(revisions, undefined);
        const next = Object.fromEntries(
          Object.entries(current).filter(([, value]) => value.expiresAt > now),
        );
        next[scope] = { revision: yield* crypto.randomUUIDv4, expiresAt: now + 60_000 };
        const encoded = yield* Schema.encodeEffect(revisionCodec)(next);
        yield* backing.set("revisions", encoded);
        yield* Cache.set(revisions, undefined, next);
      }).pipe(
        Effect.catch(() => {
          enabled = false;
          return Effect.logWarning("PR cache disabled after clearing failed");
        }),
        Effect.uninterruptible,
        lock.withPermits(CONCURRENT_READS),
      ),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(PullRequestReadCache, make).pipe(
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
