import { Context } from "effect";
import type { Effect, Scope } from "effect";

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
