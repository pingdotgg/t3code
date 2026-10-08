import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { PullRequestOperationError, PullRequestUnavailableError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Persistable from "effect/persistence/Persistable";
import * as PersistedCache from "effect/persistence/PersistedCache";
import * as Persistence from "effect/persistence/Persistence";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";

const CONCURRENT_READS = 512;
// Persistence prefixes every entry key with the store id, so each entry file
// name starts with it. The scope `revisions` file does not.
const STORE_ID = "pr-v2";
// An entry file is the store id followed by the SHA-256 hex digest of its key.
const ENTRY_FILE_NAME = new RegExp(`^${STORE_ID}[0-9a-f]{64}$`);
/**
 * Entries expire a minute after they are written, and a write sets the file's
 * mtime. A file untouched for a day is long expired; the day only leaves slack
 * for clock changes. Pruning a live entry would cost one refetch.
 */
export const ENTRY_FILE_MAX_AGE = Duration.days(1);
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
    crypto.digest("SHA-256", new TextEncoder().encode(key)).pipe(Effect.map(Hex.encode));
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
      storeId: STORE_ID,
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

/**
 * Deletes entry files in `directory` not written within `ENTRY_FILE_MAX_AGE`.
 * The persisted cache drops an expired entry only when it is read again, so
 * files for PRs nobody reopens would otherwise stay forever.
 */
export const pruneExpiredEntryFiles = Effect.fn("PullRequestReadCache.pruneExpiredEntryFiles")(
  function* (directory: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(ENTRY_FILE_MAX_AGE);
    const entries = (yield* fileSystem.readDirectory(directory)).filter((name) =>
      ENTRY_FILE_NAME.test(name),
    );
    // One file at a time, and `partition` visits every file, so one locked file
    // does not stop the sweep.
    const [, failures] = yield* Effect.partition(entries, (name) => {
      const entryPath = path.join(directory, name);
      return fileSystem.stat(entryPath).pipe(
        Effect.flatMap((info) =>
          Option.exists(info.mtime, (mtime) => mtime.getTime() < cutoff)
            ? fileSystem.remove(entryPath)
            : Effect.void,
        ),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.void),
      );
    });
    if (failures.length > 0) {
      yield* Effect.logWarning("Failed to prune some PR cache files", {
        failed: failures.length,
        cause: failures[0],
      });
    }
  },
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const directory = path.join(config.providerStatusCacheDir, "pull-requests");
    return Layer.effect(PullRequestReadCache, make).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(directory).pipe(
          // Prunes once the server is active, then every hour.
          Layer.tap(() =>
            forkParked(
              pruneExpiredEntryFiles(directory).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to prune PR cache files", { cause }),
                ),
                Effect.repeat(Schedule.spaced(Duration.hours(1))),
              ),
            ),
          ),
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
