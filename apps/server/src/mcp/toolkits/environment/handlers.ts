import * as Effect from "effect/Effect";

import { EnvironmentMcpService } from "../../EnvironmentMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { EnvironmentToolkit } from "./tools.ts";

const handlers = {
  t3_environment_read: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* EnvironmentMcpService;
      return yield* service.read(scope, input);
    }),
} satisfies Parameters<typeof EnvironmentToolkit.toLayer>[0];

export const EnvironmentToolkitHandlersLive = EnvironmentToolkit.toLayer(handlers);
