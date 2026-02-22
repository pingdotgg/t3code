import { Layer, ManagedRuntime } from "effect";

import type { OrchestrationEngine } from "./engine";
import { OrchestrationLive } from "./layers";
import { OrchestrationConfig, OrchestrationEngineService } from "./services";

export interface OrchestrationSystem {
  readonly engine: OrchestrationEngine;
  readonly dispose: () => Promise<void>;
}

export async function createOrchestrationSystem(stateDir: string): Promise<OrchestrationSystem> {
  const orchestrationLayer = OrchestrationLive.pipe(
    Layer.provide(Layer.succeed(OrchestrationConfig, { stateDir })),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(OrchestrationEngineService);
  return {
    engine,
    dispose: () => runtime.dispose(),
  };
}
