import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export function rpcInitialItems<A>(items: ReadonlyArray<A>): Stream.Stream<A> {
  let pending: ReadonlyArray<A> | undefined = items;
  return Stream.unwrap(
    Effect.sync(() => {
      const initial = pending;
      // concat retains the initial stream during live tailing; release delivered snapshots and rows.
      pending = undefined;
      return initial === undefined ? Stream.empty : Stream.fromIterable(initial);
    }),
  );
}
