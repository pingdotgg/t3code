import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

const REFRESH_TIMEOUT = Duration.seconds(30);

interface Entry<A> {
  readonly value: Option.Option<A>;
  readonly expiresAtNanos: bigint;
  readonly refreshing: boolean;
}

/**
 * Memoizes a discovery that is cheap when warm and slow on a loaded host, for
 * callers that sit on the client connect path. The first call computes inline.
 * After that every call returns the last good value immediately; once the
 * value is older than `ttl`, one detached refresh replaces it in the background.
 *
 * Only successful results are stored, so a caller interrupted mid-scan (a
 * client disconnecting, a timeout around the call) leaves the cache untouched
 * instead of replaying the interrupt to later callers. Expiry uses the
 * monotonic clock so a wall-clock adjustment cannot keep a stale entry alive.
 *
 * Refreshes run in the scope that built the cache, so they are interrupted
 * (and any scoped probe process cleaned up) when the server shuts down, and
 * each is capped at `REFRESH_TIMEOUT` so a probe hung on an unresponsive mount
 * cannot leave the entry stale forever.
 */
export const makeStaleWhileRevalidate = <A>(discover: Effect.Effect<A>, ttl: Duration.Input) => {
  const ttlNanos = Duration.toNanosUnsafe(Duration.fromInputUnsafe(ttl));
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const state = yield* Ref.make<Entry<A>>({
      value: Option.none(),
      expiresAtNanos: 0n,
      refreshing: false,
    });
    const compute = Effect.gen(function* () {
      const value = yield* discover;
      const now = yield* Clock.monotonicTimeNanos;
      yield* Ref.set(state, {
        value: Option.some(value),
        expiresAtNanos: now + ttlNanos,
        refreshing: false,
      });
      return value;
    });
    const refresh = compute.pipe(
      Effect.timeoutOption(REFRESH_TIMEOUT),
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(Ref.update(state, (entry) => ({ ...entry, refreshing: false }))),
    );
    return Effect.gen(function* () {
      const now = yield* Clock.monotonicTimeNanos;
      const entry = yield* Ref.get(state);
      if (Option.isNone(entry.value)) return yield* compute;
      if (entry.expiresAtNanos <= now) {
        // Claiming and forking are one uninterruptible step: a caller
        // interrupted between them would leave `refreshing` set with no
        // refresh running, and every later call would serve stale data.
        yield* Effect.uninterruptible(
          Ref.modify(state, (current) =>
            current.refreshing
              ? ([false, current] as const)
              : ([true, { ...current, refreshing: true }] as const),
          ).pipe(
            Effect.flatMap((claimed) => (claimed ? Effect.forkIn(refresh, scope) : Effect.void)),
          ),
        );
      }
      return entry.value.value;
    });
  });
};
