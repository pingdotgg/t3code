import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface OrchestrationReactorShape {
  /**
   * Start orchestration-side reactors for provider/runtime/checkpoint flows.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class OrchestrationReactor extends ServiceMap.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()("orchestration/OrchestrationReactor") {}
