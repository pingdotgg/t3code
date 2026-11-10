import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

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
    /** Holds new work outside the final restart check and launcher handoff. */
    readonly withRestartGate: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/updates/RestartWork") {}

export const layer = Layer.effect(
  RestartWork,
  Effect.gen(function* () {
    const active = yield* Ref.make(0);
    const gate = yield* Semaphore.make(1);
    return RestartWork.of({
      track: Effect.fn("RestartWork.track")(<A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((restore) => {
          // Only the gate wait is interruptible; the count changes with its finalizer.
          const enter: Effect.Effect<void> = Effect.flatMap(gate.takeIfAvailable(1), (taken) =>
            taken
              ? Effect.andThen(
                  Ref.update(active, (n) => n + 1),
                  gate.release(1),
                )
              : Effect.andThen(restore(gate.withPermits(1)(Effect.void)), enter),
          );
          return Effect.andThen(
            enter,
            Effect.ensuring(
              restore(effect),
              Ref.update(active, (n) => n - 1),
            ),
          );
        }),
      ),
      count: Ref.get(active),
      withRestartGate: gate.withPermits(1),
    });
  }),
);
