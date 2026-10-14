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

export const make = (seed: Iterable<readonly [key: string, version: string | null]> = []) =>
  Effect.gen(function* () {
    // `invalidate` bumps the generation in the same update that drops the
    // entry, so a lookup that started before it cannot store the answer the
    // invalidation meant to drop.
    const state = yield* Ref.make({
      generation: 0,
      entries: new Map<string, Entry>(
        Array.from(seed, ([key, version]) => [
          key,
          { version, expiresAt: Number.MAX_SAFE_INTEGER },
        ]),
      ),
    });
    return ProviderLatestVersions.of({
      cached: (key, lookup, options) =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const { generation, entries } = yield* Ref.get(state);
          const existing = entries.get(key);
          if (!options?.fresh && existing && existing.expiresAt > now) return existing.version;
          const version = yield* lookup;
          const ttl = version === null ? MISSING_TTL : FOUND_TTL;
          yield* Ref.update(state, (current) =>
            current.generation === generation
              ? {
                  generation,
                  entries: new Map(current.entries).set(key, {
                    version,
                    expiresAt: now + Duration.toMillis(ttl),
                  }),
                }
              : current,
          );
          return version;
        }),
      invalidate: (key) =>
        Ref.update(state, (current) => {
          const entries = new Map(current.entries);
          entries.delete(key);
          return { generation: current.generation + 1, entries };
        }),
    });
  });

export const layer = Layer.effect(ProviderLatestVersions, make());
