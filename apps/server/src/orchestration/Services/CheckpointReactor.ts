import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface CheckpointReactorShape {
  /**
   * Start the checkpoint reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class CheckpointReactor extends ServiceMap.Service<
  CheckpointReactor,
  CheckpointReactorShape
>()("orchestration/CheckpointReactor") {}
