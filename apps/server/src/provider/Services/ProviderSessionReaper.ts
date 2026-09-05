import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderSessionReaperShape {
  /**
   * Start the background provider session reaper within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderSessionReaper extends Context.Service<
  ProviderSessionReaper,
  ProviderSessionReaperShape
>()("t3/provider/Services/ProviderSessionReaper") {}
