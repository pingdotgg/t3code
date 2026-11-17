import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class UpdatePause extends Context.Service<
  UpdatePause,
  {
    /** Interrupts running turns before an update stops this server; they resume after it restarts. */
    readonly pauseRunsForUpdate: Effect.Effect<{ readonly pausedRuns: number }>;
  }
>()("t3/updatePause") {}
