import * as Effect from "effect/Effect";

import { EnvironmentUsageMcpService } from "../../EnvironmentUsageMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { EnvironmentUsageToolkit } from "./tools.ts";

const handlers = {
  t3_environment_usage: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* EnvironmentUsageMcpService;
      return yield* service.read(scope, input);
    }),
} satisfies Parameters<typeof EnvironmentUsageToolkit.toLayer>[0];

export const EnvironmentUsageToolkitHandlersLive = EnvironmentUsageToolkit.toLayer(handlers);
