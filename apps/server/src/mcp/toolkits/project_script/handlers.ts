import * as Effect from "effect/Effect";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectScriptMcpService } from "../../ProjectScriptMcpService.ts";
import { ProjectScriptToolkit } from "./tools.ts";

const handlers = {
  t3_project_script_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectScriptMcpService;
      return yield* service.list(scope, input);
    }),
  t3_project_script_run: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectScriptMcpService;
      return yield* service.run(scope, input);
    }),
  t3_project_script_stop: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext;
      const service = yield* ProjectScriptMcpService;
      return yield* service.stop(scope, input);
    }),
} satisfies Parameters<typeof ProjectScriptToolkit.toLayer>[0];

export const ProjectScriptToolkitHandlersLive = ProjectScriptToolkit.toLayer(handlers);
