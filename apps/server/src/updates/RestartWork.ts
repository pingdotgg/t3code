import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * Counts work a server restart would lose: project clones, workspace setup,
 * and review guides. `UpdateWindow` keeps restarts out while the count is above zero.
 */
export class RestartWork extends Context.Service<
  RestartWork,
  {
    /** Counts `effect` as restart-sensitive from now until it ends, however it ends. */
    readonly track: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly count: Effect.Effect<number>;
  }
>()("t3/updates/RestartWork") {}

export const layer = Layer.effect(
  RestartWork,
  Effect.gen(function* () {
    const active = yield* Ref.make(0);
    return RestartWork.of({
      track: (effect) =>
        Effect.acquireUseRelease(
          Ref.update(active, (n) => n + 1),
          () => effect,
          () => Ref.update(active, (n) => n - 1),
        ),
      count: Ref.get(active),
    });
  }),
);
