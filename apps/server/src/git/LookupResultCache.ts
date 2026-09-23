import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as References from "effect/References";

const snapshotStack = (
  frame: References.StackFrame | undefined,
): References.StackFrame | undefined => {
  if (frame === undefined) return undefined;
  const stack = frame.stack();
  return { name: frame.name, stack: () => stack, parent: snapshotStack(frame.parent) };
};

// Completed Effect cache fibers can retain a caller's lazy trace stack and its
// request snapshot. Store only the result; running lookups belong to the service scope.
export const make = Effect.fnUntraced(function* <Key, A, E>(
  lookup: (key: Key) => Effect.Effect<A, E>,
  options: {
    readonly capacity: number;
    readonly timeToLive: (exit: Exit.Exit<A, E>, key: Key) => Duration.Input;
  },
) {
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const entries = new Map<
    Key,
    {
      readonly result: Deferred.Deferred<A, E>;
      expiresAt: number;
    }
  >();
  const existing = (key: Key) => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= clock.currentTimeMillisUnsafe()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };
  const get = Effect.fnUntraced(function* (key: Key) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const cached = existing(key);
        if (cached !== undefined) return yield* restore(Deferred.await(cached.result));
        const entry = { result: yield* Deferred.make<A, E>(), expiresAt: Infinity };
        entries.set(key, entry);
        if (entries.size > options.capacity) {
          const oldest = entries.keys().next();
          if (!oldest.done) entries.delete(oldest.value);
        }
        const stack = snapshotStack(yield* References.CurrentStackFrame);
        yield* Effect.forkIn(
          Effect.exit(Effect.interruptible(Effect.suspend(() => lookup(key)))).pipe(
            Effect.provideService(References.CurrentStackFrame, stack),
            Effect.flatMap((exit) =>
              Effect.gen(function* () {
                entry.expiresAt =
                  clock.currentTimeMillisUnsafe() +
                  Duration.toMillis(Duration.fromInputUnsafe(options.timeToLive(exit, key)));
                yield* Deferred.done(entry.result, exit);
              }),
            ),
          ),
          scope,
        );
        return yield* restore(Deferred.await(entry.result));
      }),
    );
  });
  return {
    get,
    getOption: (key: Key) =>
      Effect.suspend(() => {
        const entry = existing(key);
        return entry === undefined
          ? Effect.succeed(Option.none<A>())
          : Effect.map(Deferred.await(entry.result), Option.some);
      }),
    invalidate: (key: Key) =>
      Effect.sync(() => {
        entries.delete(key);
      }),
  };
});
