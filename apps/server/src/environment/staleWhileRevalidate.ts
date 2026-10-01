import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

const REFRESH_TIMEOUT = Duration.seconds(30);

type Entry<A> =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Scanning"; readonly scan: Deferred.Deferred<A> }
  | {
      readonly _tag: "Ready";
      readonly value: A;
      readonly expiresAtNanos: bigint;
      readonly refreshing: boolean;
    };

/**
 * Memoizes a discovery that is cheap when warm and slow on a loaded host, for
 * callers that sit on the client connect path. Until a value exists, callers
 * wait on one shared scan. After that every call returns the last good value
 * immediately; once the value is older than `ttl`, one refresh replaces it in
 * the background.
 *
 * Scans run on their own fiber in the scope that built the cache, never on a
 * caller's. Callers time out and disconnect mid-connect, and neither may cancel
 * a scan other callers are waiting on, or throw away work a slow host needs
 * more than one connect to finish. Only successes are stored: a failed scan
 * leaves the previous state, so the next caller starts over. Expiry uses the
 * monotonic clock so a wall-clock adjustment cannot keep a stale entry alive.
 *
 * Closing the scope interrupts any scan (and cleans up a scoped probe process).
 * A refresh is capped at `REFRESH_TIMEOUT` so a probe hung on an unresponsive
 * mount cannot leave the entry stale forever; a first scan is not, because
 * callers that already timed out still pick up its result later.
 */
export const makeStaleWhileRevalidate = <A>(discover: Effect.Effect<A>, ttl: Duration.Input) => {
  const ttlNanos = Duration.toNanosUnsafe(Duration.fromInputUnsafe(ttl));
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const state = yield* Ref.make<Entry<A>>({ _tag: "Empty" });

    const settle = (exit: Exit.Exit<A>) =>
      Effect.gen(function* () {
        const now = yield* Clock.monotonicTimeNanos;
        yield* Ref.update(state, (entry): Entry<A> =>
          Exit.isSuccess(exit)
            ? {
                _tag: "Ready",
                value: exit.value,
                expiresAtNanos: now + ttlNanos,
                refreshing: false,
              }
            : entry._tag === "Ready"
              ? { ...entry, refreshing: false }
              : { _tag: "Empty" },
        );
      });
    const fork = (scan: Effect.Effect<unknown>) =>
      scan.pipe(Effect.ignoreCause({ log: true }), Effect.interruptible, Effect.forkIn(scope));
    const firstScan = (scan: Deferred.Deferred<A>) =>
      fork(
        discover.pipe(
          Effect.onExit((exit) => settle(exit).pipe(Effect.andThen(Deferred.done(scan, exit)))),
        ),
      );
    const refresh = fork(
      discover.pipe(Effect.onExit(settle), Effect.timeoutOption(REFRESH_TIMEOUT)),
    );

    return Effect.gen(function* () {
      const now = yield* Clock.monotonicTimeNanos;
      // Claiming a scan and starting it are one uninterruptible step: a caller
      // interrupted between them would leave a claimed scan that never runs.
      const result = yield* Ref.modify(
        state,
        (entry): readonly [readonly [Effect.Effect<unknown>, Effect.Effect<A>], Entry<A>] => {
          switch (entry._tag) {
            case "Empty": {
              const scan = Deferred.makeUnsafe<A>();
              return [[firstScan(scan), Deferred.await(scan)], { _tag: "Scanning", scan }];
            }
            case "Scanning":
              return [[Effect.void, Deferred.await(entry.scan)], entry];
            case "Ready":
              return entry.refreshing || entry.expiresAtNanos > now
                ? [[Effect.void, Effect.succeed(entry.value)], entry]
                : [[refresh, Effect.succeed(entry.value)], { ...entry, refreshing: true }];
          }
        },
      ).pipe(
        Effect.flatMap(([start, result]) => Effect.as(start, result)),
        Effect.uninterruptible,
      );
      return yield* result;
    });
  });
};
