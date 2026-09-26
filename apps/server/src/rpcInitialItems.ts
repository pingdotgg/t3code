import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** A request-owned prefix, consumed once before its RPC's live stream. */
export function rpcInitialItems<A>(items: ReadonlyArray<A>): Stream.Stream<A> {
  let pending: ReadonlyArray<A> | undefined = items;
  return Stream.unwrap(
    Effect.sync(() => {
      const initial = pending;
      // concat keeps its initial stream definition alive during the live tail.
      // That definition must no longer own delivered snapshots or replay rows.
      pending = undefined;
      return initial === undefined ? Stream.empty : Stream.fromIterable(initial);
    }),
  );
}
