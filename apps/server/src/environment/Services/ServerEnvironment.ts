import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends Context.Service<ServerEnvironment, ServerEnvironmentShape>()(
  "t3/environment/Services/ServerEnvironment",
) {}
