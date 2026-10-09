/**
 * Memoizes "latest available version" lookups (npm registry, release
 * channels) for the version advisory. One instance is shared by every driver
 * and the maintenance runner, so a provider update can invalidate the entry
 * the next snapshot refresh reads.
 *
 * @module provider-core/server/ProviderLatestVersions
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** A found version stays fresh this long. */
const FOUND_TTL = Duration.hours(1);
/** A failed lookup is retried sooner, so a flaky network does not hide an update for an hour. */
const MISSING_TTL = Duration.minutes(1);

interface Entry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export class ProviderLatestVersions extends Context.Service<
  ProviderLatestVersions,
  {
    /**
     * Returns the cached version for `key`, running `lookup` when there is no
     * fresh entry or `fresh` is set. `null` means the lookup found nothing.
     */
    readonly cached: <E, R>(
      key: string,
      lookup: Effect.Effect<string | null, E, R>,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<string | null, E, R>;
    readonly invalidate: (key: string) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/ProviderLatestVersions") {}

/** Starts from `seed`, for tests that need a cached entry. */
export const make = (seed: Iterable<readonly [key: string, version: string | null]> = []) =>
  Effect.gen(function* () {
    const entries = yield* Ref.make(
      new Map<string, Entry>(
        Array.from(seed, ([key, version]) => [
          key,
          { version, expiresAt: Number.MAX_SAFE_INTEGER },
        ]),
      ),
    );
    return ProviderLatestVersions.of({
      cached: (key, lookup, options) =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const existing = (yield* Ref.get(entries)).get(key);
          if (!options?.fresh && existing && existing.expiresAt > now) return existing.version;
          const version = yield* lookup;
          const ttl = version === null ? MISSING_TTL : FOUND_TTL;
          yield* Ref.update(entries, (current) =>
            new Map(current).set(key, { version, expiresAt: now + Duration.toMillis(ttl) }),
          );
          return version;
        }),
      invalidate: (key) =>
        Ref.update(entries, (current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        }),
    });
  });

export const layer = Layer.effect(ProviderLatestVersions, make());
