import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * Builds `Cache.get` for a service whose concurrent callers share one lookup. Run it while the
 * service is built, so the lookups are owned by the service's scope.
 *
 * `Cache` interrupts a lookup when its last awaiter leaves. A caller arriving while that
 * interruption unwinds joins the dying lookup and fails with a bare interrupt, which is how one
 * caller's cancellation surfaced as another caller's failure. Awaiting from a fiber owned by
 * the service scope means a cancelled caller only stops waiting and never interrupts the shared
 * lookup, while closing the scope still interrupts it.
 */
export const makeSharedCacheGet = Effect.map(
  Effect.scope,
  (scope) =>
    <Key, A, E, R>(cache: Cache.Cache<Key, A, E, R>, key: Key): Effect.Effect<A, E, R> =>
      Effect.forkIn(Cache.get(cache, key), scope, { startImmediately: true }).pipe(
        Effect.flatMap(Fiber.join),
      ),
);
