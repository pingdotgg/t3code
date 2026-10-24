import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const FOUND_TTL = Duration.hours(1);
const MISSING_TTL = Duration.minutes(1);

interface Entry {
  readonly expiresAt: number;
  readonly version: string | null;
  readonly completion?: Deferred.Deferred<void>;
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
  const cached: ProviderLatestVersions["Service"]["cached"] = Effect.fn(
    "ProviderLatestVersions.cached",
  )(function* (key, lookup, options) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const pending = { version: null, expiresAt: 0, completion: Deferred.makeUnsafe<void>() };
        const existing = yield* Ref.modify(entries, (current) => {
          const entry = current.get(key);
          const reusable =
            !options?.fresh && entry && (entry.completion || entry.expiresAt > now)
              ? entry
              : undefined;
          return [reusable, reusable ? current : new Map(current).set(key, pending)] as const;
        });
        if (existing) {
          return existing.completion
            ? yield* restore(
                Deferred.await(existing.completion).pipe(Effect.andThen(() => cached(key, lookup))),
              )
            : existing.version;
        }
        return yield* restore(lookup).pipe(
          Effect.tap((version) =>
            Ref.update(entries, (current) =>
              current.get(key) === pending
                ? new Map(current).set(key, {
                    version,
                    expiresAt: now + Duration.toMillis(version === null ? MISSING_TTL : FOUND_TTL),
                  })
                : current,
            ),
          ),
          Effect.ensuring(
            Ref.update(entries, (current) => {
              if (current.get(key) !== pending) return current;
              const next = new Map(current);
              next.delete(key);
              return next;
            }).pipe(Effect.andThen(Deferred.succeed(pending.completion, undefined))),
          ),
        );
      }),
    );
  });
  return ProviderLatestVersions.of({
    cached,
    invalidate: (key) =>
      Ref.update(entries, (current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      }),
  });
});

export const layer = Layer.effect(ProviderLatestVersions, make());
