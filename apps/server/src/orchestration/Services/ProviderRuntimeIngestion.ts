import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface ProviderRuntimeIngestionShape {
  /**
   * Start ingesting provider runtime events into orchestration commands.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderRuntimeIngestionService extends ServiceMap.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("orchestration/ProviderRuntimeIngestion") {}
