import { Context } from "effect";

import { OrchestrationEngine } from "./engine";
import type { OrchestrationEventStore } from "./eventStore";

export interface OrchestrationConfigShape {
  readonly stateDir: string;
}

export class OrchestrationConfig extends Context.Tag("orchestration/Config")<
  OrchestrationConfig,
  OrchestrationConfigShape
>() {}

export class OrchestrationEventStoreService extends Context.Tag(
  "orchestration/EventStore",
)<OrchestrationEventStoreService, OrchestrationEventStore>() {}

export class OrchestrationEngineService extends Context.Tag("orchestration/Engine")<
  OrchestrationEngineService,
  OrchestrationEngine
>() {}
