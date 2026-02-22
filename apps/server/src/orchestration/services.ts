import { Context } from "effect";

import { OrchestrationEngine } from "./engine";

export interface OrchestrationConfigShape {
  readonly stateDir: string;
}

export class OrchestrationConfig extends Context.Tag("orchestration/Config")<
  OrchestrationConfig,
  OrchestrationConfigShape
>() {}

export class OrchestrationEngineService extends Context.Tag("orchestration/Engine")<
  OrchestrationEngineService,
  OrchestrationEngine
>() {}
