/**
 * ProviderRateLimitReactor - Provider usage-limit reaction service interface.
 *
 * Tracks the usage-limit state each provider instance reports and, when the
 * user opted in, moves limited threads to a sibling account.
 *
 * @module ProviderRateLimitReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderRateLimitReactorShape {
  /**
   * Start consuming provider runtime events. The returned effect must be run
   * in a scope so the worker fiber is finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when every queued event has been processed. Test use only. */
  readonly drain: Effect.Effect<void>;
}

export class ProviderRateLimitReactor extends Context.Service<
  ProviderRateLimitReactor,
  ProviderRateLimitReactorShape
>()("t3/orchestration/Services/ProviderRateLimitReactor") {}
