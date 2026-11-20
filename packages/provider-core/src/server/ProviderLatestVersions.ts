import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

const FOUND_TTL = Duration.hours(1);
const MISSING_TTL = Duration.minutes(1);

interface Entry {
  readonly expiresAt: number;
  readonly version: string | null;
  readonly inFlight?: Deferred.Deferred<Option.Option<string | null>>;
}

export class ProviderLatestVersions extends Context.Service<
  ProviderLatestVersions,
  {
    readonly cached: <E, R>(
      key: string,
      lookup: Effect.Effect<string | null, E, R>,
      options?: { readonly fresh?: boolean; readonly fallbackToStale?: boolean },
    ) => Effect.Effect<string | null, E, R>;
    /** Returns the last non-null version observed for `key`, even after invalidation or expiry. */
    readonly lastKnown: (key: string) => Effect.Effect<string | null>;
    readonly invalidate: (key: string) => Effect.Effect<void>;
    readonly invalidateAll: Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/ProviderLatestVersions") {}

export const make = Effect.fn("ProviderLatestVersions.make")(function* (
  seed: Iterable<readonly [key: string, version: string | null]> = [],
) {
  const seedEntries = Array.from(seed);
  // `lastKnown` retains the last non-null version per key across invalidations and transient null
  // lookups so advisory refreshes do not flicker known updates out on a timeout or network blip.
  const state = yield* Ref.make({
    entries: new Map<string, Entry>(
      seedEntries.map(([key, version]) => [key, { version, expiresAt: Number.MAX_SAFE_INTEGER }]),
    ),
    lastKnown: new Map<string, string>(
      seedEntries.flatMap(([key, version]) => (version !== null ? [[key, version] as const] : [])),
    ),
  });
  const cached: ProviderLatestVersions["Service"]["cached"] = Effect.fn(
    "ProviderLatestVersions.cached",
  )(function* (key, lookup, options) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const inFlight = yield* Deferred.make<Option.Option<string | null>>();
    // Replacing or invalidating this entry retires any lookup still in flight.
    const pending: Entry = { version: null, expiresAt: 0, inFlight };
    // Claim and cleanup registration must be atomic with respect to interruption.
    const resolved = yield* Effect.acquireUseRelease(
      Ref.modify(state, (current) => {
        const entry = current.entries.get(key);
        return !options?.fresh && entry && (entry.expiresAt > now || entry.inFlight)
          ? [entry, current]
          : [undefined, { ...current, entries: new Map(current.entries).set(key, pending) }];
      }),
      (existing) =>
        Effect.gen(function* () {
          if (!existing) return yield* lookup;
          if (!existing.inFlight) return existing.version;
          const shared = yield* Deferred.await(existing.inFlight);
          return Option.isSome(shared) ? shared.value : yield* cached(key, lookup, options);
        }),
      (existing, exit) => {
        if (existing) return Effect.void;
        const version = Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none();
        return Ref.update(state, (current) => {
          if (current.entries.get(key) !== pending) return current;
          const nextEntries = new Map(current.entries);
          if (Option.isNone(version)) {
            nextEntries.delete(key);
            return { ...current, entries: nextEntries };
          }
          const ttl = version.value === null ? MISSING_TTL : FOUND_TTL;
          nextEntries.set(key, { version: version.value, expiresAt: now + Duration.toMillis(ttl) });
          const nextLastKnown =
            version.value !== null
              ? new Map(current.lastKnown).set(key, version.value)
              : current.lastKnown;
          return { entries: nextEntries, lastKnown: nextLastKnown };
        }).pipe(Effect.andThen(Deferred.succeed(inFlight, version)), Effect.asVoid);
      },
    );
    if (resolved !== null || options?.fallbackToStale !== true) {
      return resolved;
    }
    return (yield* Ref.get(state)).lastKnown.get(key) ?? null;
  });
  return ProviderLatestVersions.of({
    cached,
    lastKnown: Effect.fn("ProviderLatestVersions.lastKnown")(function (key) {
      return Ref.get(state).pipe(Effect.map((current) => current.lastKnown.get(key) ?? null));
    }),
    invalidate: Effect.fn("ProviderLatestVersions.invalidate")(function (key) {
      return Ref.update(state, (current) => {
        const nextEntries = new Map(current.entries);
        nextEntries.delete(key);
        return { ...current, entries: nextEntries };
      });
    }),
    invalidateAll: Ref.update(state, (current) => ({ ...current, entries: new Map() })),
  });
});

export const layer = Layer.effect(ProviderLatestVersions, make());
