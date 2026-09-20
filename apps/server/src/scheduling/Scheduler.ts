import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** Sources load due work from their durable state; registration owns its execution lifetime. */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly register: <E, R>(
      name: string,
      runDueWork: Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, never, R | Scope.Scope>;
  }
>()("t3/scheduling/Scheduler") {}

export const layer = Layer.effect(
  Scheduler,
  Effect.gen(function* () {
    const sources = yield* Ref.make(new Map<symbol, Effect.Effect<void>>());
    const register: Scheduler["Service"]["register"] = Effect.fn("Scheduler.register")(function* <
      E,
      R,
    >(name: string, runDueWork: Effect.Effect<void, E, R>) {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<R>();
      const permit = yield* Semaphore.make(1);
      const run = runDueWork.pipe(
        Effect.provideContext(context),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Scheduler source failed", { source: name, cause }),
        ),
        permit.withPermitsIfAvailable(1),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
      const id = Symbol(name);
      yield* Effect.acquireRelease(
        Ref.update(sources, (current) => new Map(current).set(id, run)),
        () =>
          Ref.update(sources, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
      );
    });
    const tick = Ref.get(sources).pipe(
      Effect.flatMap((current) =>
        Effect.forEach(current.values(), (run) => run, { discard: true }),
      ),
    );
    // One clock for all due-work sources. A slow source cannot block another
    // source or overlap itself, and no extra missed-tick backlog is queued.
    yield* Effect.sleep("5 seconds").pipe(Effect.andThen(tick), Effect.forever, Effect.forkScoped);
    return Scheduler.of({ register });
  }),
);
