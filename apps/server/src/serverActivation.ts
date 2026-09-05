import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as NodeCrypto from "node:crypto";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

// Detached background work runs under a fresh stateless root instead of the
// ambient ParentSpan, so long-lived fibers never pin the short-lived span that
// happened to be ambient at fork time (#5410). An external span carries only
// trace/span ids and never accumulates children, so unlike a live startup span
// it cannot pin unbounded tracing state. Re-rooting (instead of omitting
// ParentSpan from the context) keeps every effect working: effects that
// explicitly require a ParentSpan observe the fresh root instead of dying with
// Service-not-found, which makes the Exclude in the return type honest.
export const withDetachedSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> =>
  Effect.flatMap(
    Effect.sync(() => {
      const traceId = NodeCrypto.randomUUID().replaceAll("-", "");
      return Tracer.externalSpan({
        traceId,
        spanId: traceId.slice(0, 16),
        sampled: true,
      });
    }),
    (root) => Effect.provideService(effect, Tracer.ParentSpan, root),
  );

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | Exclude<R, Tracer.ParentSpan>> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    const detached = withDetachedSpan(effect);
    if (activation === undefined) {
      yield* Effect.forkScoped(detached);
      return;
    }
    const parked = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      Deferred.succeed(parked, undefined).pipe(
        Effect.andThen(activation),
        Effect.andThen(detached),
      ),
    );
    yield* Deferred.await(parked);
  });
