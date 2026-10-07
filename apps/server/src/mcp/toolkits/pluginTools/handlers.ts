import * as Effect from "effect/Effect";

import * as PluginTools from "../../../plugins/PluginTools.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PluginToolsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const tools = yield* PluginTools.PluginTools;
  return {
    // Scope and grants come from the session's credential, never from the agent.
    plugin_tools_list: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          tools.list(scope.pluginToolGrants ?? [], {
            ...(input.plugin === undefined ? {} : { plugin: input.plugin }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          }),
        ),
      ),
    ),
    // A plugin tool runs on behalf of the calling thread while its run is live, so a client
    // signed in from outside T3 Code (no thread, no grants) cannot call one.
    plugin_tool_call: McpToolAccess.actsAsCaller((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) =>
          McpInvocationContext.requireThreadScope(scope, "plugin_tool_call"),
        ),
        Effect.flatMap((scope) =>
          tools.call(scope.pluginToolGrants ?? [], {
            tool: input.tool,
            input: input.input ?? {},
            context: { environmentId: scope.environmentId, threadId: scope.thread.threadId },
          }),
        ),
        Effect.map((result) => ({ result })),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof PluginToolsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PluginToolsToolkit, make);
