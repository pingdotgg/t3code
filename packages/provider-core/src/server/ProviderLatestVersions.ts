import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const FOUND_TTL = Duration.hours(1);
const MISSING_TTL = Duration.minutes(1);

interface Entry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export class ProviderLatestVersions extends Context.Service<
  ProviderLatestVersions,
  {
    readonly cached: <E, R>(
      key: string,
      lookup: Effect.Effect<string | null, E, R>,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<string | null, E, R>;
    readonly invalidate: (key: string) => Effect.Effect<void>;
  }
>()("@t3tools/provider-core/server/ProviderLatestVersions") {}

export const make = Effect.fn("ProviderLatestVersions.make")(function* (
  seed: Iterable<readonly [key: string, version: string | null]> = [],
) {
  const entries = yield* Ref.make(
    new Map<string, Entry>(
      Array.from(seed, ([key, version]) => [key, { version, expiresAt: Number.MAX_SAFE_INTEGER }]),
    ),
  );
  return ProviderLatestVersions.of({
    cached: Effect.fn("ProviderLatestVersions.cached")(function* (key, lookup, options) {
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
