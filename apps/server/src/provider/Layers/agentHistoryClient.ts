import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";

/** Share read-only transports across cards without retaining idle processes or session state. */
export const makeAgentHistoryClient = Effect.fn("makeAgentHistoryClient")(function* <A, E, R>(
  lookup: (cwd: string) => Effect.Effect<A, E, R | Scope.Scope>,
) {
  const clients = yield* RcMap.make({
    lookup: (cwd: string) => lookup(cwd).pipe(Effect.timeout("20 seconds")),
    idleTimeToLive: "30 seconds",
    capacity: 8,
  });
  return <B, E2>(cwd: string, read: (client: A) => Effect.Effect<B, E2>) =>
    Effect.scoped(RcMap.get(clients, cwd).pipe(Effect.flatMap(read))).pipe(
      Effect.timeout("20 seconds"),
      Effect.onError(() => RcMap.invalidate(clients, cwd)),
    );
});
