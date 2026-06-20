import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopShutdown extends Context.Service<
  DesktopShutdown,
  {
    readonly request: Effect.Effect<void>;
    readonly awaitRequest: Effect.Effect<void>;
    readonly markComplete: Effect.Effect<void>;
    readonly awaitComplete: Effect.Effect<void>;
    readonly isComplete: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopShutdown") {}

const make = Effect.gen(function* () {
  const requested = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const completedRef = yield* Ref.make(false);

  return DesktopShutdown.of({
    request: Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    awaitRequest: Deferred.await(requested),
    markComplete: Ref.set(completedRef, true).pipe(
      Effect.andThen(Deferred.succeed(completed, undefined)),
      Effect.asVoid,
    ),
    awaitComplete: Deferred.await(completed),
    isComplete: Ref.get(completedRef),
  });
});

export const layer = Layer.effect(DesktopShutdown, make);
