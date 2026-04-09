import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends ServiceMap.Service<
  ServerEnvironment,
  ServerEnvironmentShape
>()("t3/environment/Services/ServerEnvironment") {}
