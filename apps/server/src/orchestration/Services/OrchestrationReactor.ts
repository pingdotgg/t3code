/**
 * OrchestrationReactor - Composite orchestration reactor service interface.
 *
 * Coordinates startup of orchestration runtime reactors that translate domain
 * events into downstream side effects.
 *
 * @module OrchestrationReactor
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

/**
 * OrchestrationReactorShape - Service API for orchestration reactor lifecycle.
 */
export interface OrchestrationReactorShape {
  /**
   * Start orchestration-side reactors for provider/runtime/checkpoint flows.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

/**
 * OrchestrationReactor - Service tag for orchestration reactor coordination.
 */
export class OrchestrationReactor extends ServiceMap.Service<
  OrchestrationReactor,
  OrchestrationReactorShape
>()("orchestration/OrchestrationReactor") {}
