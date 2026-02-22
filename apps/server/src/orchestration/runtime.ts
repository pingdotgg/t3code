import { Effect, Layer, Runtime } from "effect";

import type { OrchestrationEngine } from "./engine";
import { OrchestrationLive } from "./layers";
import { OrchestrationConfig, OrchestrationEngineService } from "./services";

export function createOrchestrationEngine(stateDir: string): OrchestrationEngine {
  const orchestrationLayer = OrchestrationLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationConfig, { stateDir })),
  );
  return Runtime.runSync(Runtime.defaultRuntime)(
    Effect.provide(OrchestrationEngineService, orchestrationLayer),
  );
}
