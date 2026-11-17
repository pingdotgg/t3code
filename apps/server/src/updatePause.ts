import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class UpdatePause extends Context.Service<
  UpdatePause,
  {
    /** Interrupts running turns before an update stops this server; they resume after it restarts. */
    readonly pauseRunsForUpdate: Effect.Effect<{ readonly pausedRuns: number }>;
    /** Undoes a pause no restart followed; paused turns resume through their continuations. */
    readonly resumeRunsAfterUpdate: Effect.Effect<void>;
  }
>()("t3/updatePause") {}
