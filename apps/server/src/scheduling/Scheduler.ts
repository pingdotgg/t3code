import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly register: <E, R>(
      name: string,
      runDueWork: Effect.Effect<void, E, R>,
      awaitNext?: Effect.Effect<void>,
    ) => Effect.Effect<void, never, R | Scope.Scope>;
  }
>()("t3/scheduling/Scheduler") {}

const register: Scheduler["Service"]["register"] = Effect.fn("Scheduler.register")(function* <E, R>(
  name: string,
  runDueWork: Effect.Effect<void, E, R>,
  awaitNext = Effect.sleep("5 seconds"),
) {
  const run = runDueWork.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Effect.logWarning("Scheduler source failed", { source: name, cause }),
    ),
  );
  // Due work waits for startup recovery, which would cancel runs it started.
  yield* forkParked(run.pipe(Effect.andThen(awaitNext), Effect.forever));
});

export const layer = Layer.succeed(Scheduler, { register });
