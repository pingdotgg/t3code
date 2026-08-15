import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class TurnAdmissionGate extends Context.Service<
  TurnAdmissionGate,
  {
    /** Serialize queued turn processing with update handoff and fail once handoff commits. */
    readonly admitTurn: <A, E, R, EClosed>(
      effect: Effect.Effect<A, E, R>,
      onClosed: () => EClosed,
    ) => Effect.Effect<A, E | EClosed, R>;

    /**
     * On success, permanently close turn admission in this process. A failed
     * launcher handoff leaves admission open.
     */
    readonly commitUpdateHandoff: <A, E, R>(
      handoff: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/orchestration/TurnAdmissionGate") {}

export const make = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  let closed = false;

  function admitTurn<A, E, R, EClosed>(
    effect: Effect.Effect<A, E, R>,
    onClosed: () => EClosed,
  ): Effect.Effect<A, E | EClosed, R> {
    return semaphore.withPermit(
      Effect.suspend(
        (): Effect.Effect<A, E | EClosed, R> => (closed ? Effect.fail(onClosed()) : effect),
      ),
    );
  }

  return TurnAdmissionGate.of({
    admitTurn,
    commitUpdateHandoff: (handoff) =>
      semaphore.withPermit(
        handoff.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(TurnAdmissionGate, make);
