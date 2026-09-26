import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as NodeCrypto from "node:crypto";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

// Replace and flatten the context before forking: Context.add retains the old
// parent in its overlay, while providing inside the child retains a restoration
// frame for the lifetime of the work. The external root does not collect children.
export const forkScopedDetached = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | Exclude<R, Tracer.ParentSpan>> =>
  Effect.updateContext(
    Effect.forkScoped(effect),
    (context: Context.Context<Scope.Scope | Exclude<R, Tracer.ParentSpan>>) => {
      const traceId = NodeCrypto.randomUUID().replaceAll("-", "");
      const root = Tracer.externalSpan({
        traceId,
        spanId: traceId.slice(0, 16),
        sampled: true,
      });
      const detached = Context.add(context, Tracer.ParentSpan, root);
      return Context.makeUnsafe<Scope.Scope | R>(new Map(detached.mapUnsafe));
    },
  );

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | Exclude<R, Tracer.ParentSpan>> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* forkScopedDetached(effect);
      return;
    }
    const parked = yield* Deferred.make<void>();
    yield* forkScopedDetached(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
  });
