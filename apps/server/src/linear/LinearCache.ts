import type { IssueTrackerError } from "@t3tools/issue-tracker-core/errors";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";

export interface CacheHit<V> {
  readonly value: V;
  /** True when Linear failed or rate limited and this older entry was served instead. */
  readonly stale: boolean;
  readonly fetchedAtMs: number;
}

interface Entry<V> {
  readonly value: V;
  readonly fetchedAtMs: number;
  /** Set by `expire`: the value is still a valid outage fallback but no longer counts as fresh. */
  readonly expired: boolean;
}

export interface LinearCache<V> {
  readonly get: (
    key: string,
    ttlMs: number,
    load: Effect.Effect<V, IssueTrackerError>,
  ) => Effect.Effect<CacheHit<V>, IssueTrackerError>;
  /** Drops every entry, including outage fallbacks. */
  readonly clear: Effect.Effect<void>;
  /** Forces the next read to reload while keeping entries as outage fallbacks. */
  readonly expire: Effect.Effect<void>;
}

/** Stale entries are an outage fallback, not a long-term store. */
const MAX_STALE_AGE_MS = 60 * 60 * 1000;

/** Only outages may be papered over; a rejected key or a missing item must surface. */
const canServeStale = (error: IssueTrackerError) =>
  error._tag === "IssueTrackerRateLimited" || error._tag === "IssueTrackerUnavailable";

/**
 * A bounded LRU with a TTL per read. Concurrent misses for one key share a single load, run in a
 * detached fiber so one caller's interruption cannot fail the others. Failed loads leave the entry
 * in place and answer with it (marked stale) when the failure is an outage.
 */
export const makeLinearCache = <V>(capacity: number): LinearCache<V> => {
  // Map iteration order is insertion order; re-inserting on read keeps the oldest-used key first.
  const entries = new Map<string, Entry<V>>();
  const inflight = new Map<string, Deferred.Deferred<Entry<V>, IssueTrackerError>>();

  const remember = (key: string, entry: Entry<V>) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > capacity) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  const startLoad = Effect.fn("LinearCache.startLoad")(function* (
    key: string,
    load: Effect.Effect<V, IssueTrackerError>,
  ) {
    const deferred = yield* Deferred.make<Entry<V>, IssueTrackerError>();
    inflight.set(key, deferred);
    yield* Effect.forkDetach(
      load.pipe(
        Effect.flatMap((value) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((fetchedAtMs): Entry<V> => ({ value, fetchedAtMs, expired: false })),
          ),
        ),
        Effect.tap((entry) => Effect.sync(() => remember(key, entry))),
        Effect.exit,
        Effect.flatMap((exit: Exit.Exit<Entry<V>, IssueTrackerError>) =>
          Effect.sync(() => inflight.delete(key)).pipe(
            Effect.andThen(Deferred.done(deferred, exit)),
          ),
        ),
      ),
    );
    return deferred;
  });

  return {
    get: Effect.fn("LinearCache.get")(function* (key, ttlMs, load) {
      const now = yield* Clock.currentTimeMillis;
      const cached = entries.get(key);
      if (cached !== undefined && !cached.expired && now - cached.fetchedAtMs < ttlMs) {
        remember(key, cached);
        return { value: cached.value, stale: false, fetchedAtMs: cached.fetchedAtMs };
      }
      const pending = inflight.get(key) ?? (yield* startLoad(key, load));
      return yield* Deferred.await(pending).pipe(
        Effect.map((entry) => ({
          value: entry.value,
          stale: false,
          fetchedAtMs: entry.fetchedAtMs,
        })),
        Effect.catchIf(
          (error) =>
            cached !== undefined &&
            canServeStale(error) &&
            now - cached.fetchedAtMs < MAX_STALE_AGE_MS,
          () =>
            Effect.succeed({
              value: cached!.value,
              stale: true,
              fetchedAtMs: cached!.fetchedAtMs,
            }),
        ),
      );
    }),
    clear: Effect.sync(() => {
      entries.clear();
    }),
    expire: Effect.sync(() => {
      for (const [key, entry] of entries) entries.set(key, { ...entry, expired: true });
    }),
  };
};
