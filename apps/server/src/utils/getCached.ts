import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * `Cache.get` for a caller that must not inherit another caller's interrupt.
 *
 * When a lookup's last caller is interrupted, `Cache` interrupts the lookup but
 * keeps its entry until the lookup has stopped. A caller that arrives in that
 * window joins the dying lookup and fails with a bare interrupt. The entry is
 * gone by the time that failure arrives, so one more `get` starts a fresh
 * lookup. A caller that was itself interrupted never reaches the retry.
 */
export const getCached = <Key, A, E, R>(
  cache: Cache.Cache<Key, A, E, R>,
  key: Key,
): Effect.Effect<A, E, R> =>
  Cache.get(cache, key).pipe(
    Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Cache.get(cache, key)),
  );
