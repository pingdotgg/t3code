import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderCommandReactor extends ServiceMap.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("orchestration/ProviderCommandReactor") {}
