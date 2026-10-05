import { waitUntil as nativeWaitUntil } from "@neon/functions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * Run bounded post-response work with its own scope. Failures are logged.
 * Neon limits waitUntil work to fifteen minutes; this is not a durable job.
 */
export const waitUntil = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, RuntimeContext | Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
    const memoMap = yield* Layer.makeMemoMap;
    yield* Effect.sync(() =>
      nativeWaitUntil(
        Effect.runPromiseWith(context)(
          effect.pipe(
            Effect.scoped,
            Effect.provideService(Layer.CurrentMemoMap, memoMap),
            Effect.timeout("15 minutes"),
            Effect.tapCause(() =>
              Effect.logError("Neon waitUntil task failed"),
            ),
          ),
        ),
      ),
    );
  });
