import { OrchestratorMcpFailure, PluginToolError, PluginToolsListResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

const PluginToolsListTool = Tool.make("plugin_tools_list", {
  description:
    "List the tools offered by the user's trusted local T3 Code plugins that this session may use. Each entry has the tool name to pass to plugin_tool_call, its inputSchema, and its sideEffect (read, write or destructive). Listing starts no plugin. Results come in pages ordered by plugin id: when nextCursor is present, pass it as cursor for more. Pass plugin to list one plugin's tools. Plugins enabled after this session started appear under notInThisSession and need a new session.",
  parameters: Schema.Struct({
    plugin: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(128)).annotate({
        description: "A plugin id, such as acme.search, to list only that plugin's tools.",
      }),
    ),
    cursor: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(128)).annotate({
        description: "The nextCursor of the previous page.",
      }),
    ),
  }),
  success: PluginToolsListResult,
  failure: PluginToolError,
  dependencies,
})
  .annotate(Tool.Title, "List plugin tools")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/**
 * One fixed tool calls every plugin tool, so its hints describe the most a
 * plugin tool may do. Each tool's own sideEffect is in plugin_tools_list.
 */
const PluginToolCallTool = Tool.make("plugin_tool_call", {
  description:
    "Call a tool from plugin_tools_list. Pass its tool name and an input object that matches its inputSchema. Check the tool's sideEffect first: write and destructive tools change things, so follow the user's instructions about such changes.",
  parameters: Schema.Struct({
    tool: Schema.String.check(Schema.isMaxLength(200)).annotate({
      description: "The tool value from plugin_tools_list, such as acme.search/lookup.",
    }),
    input: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Arguments matching the tool's inputSchema. Defaults to {}.",
      }),
    ),
  }),
  success: Schema.Struct({ result: Schema.Unknown }),
  // The caller check refuses an outside client or a thread whose run has ended.
  failure: Schema.Union([PluginToolError, OrchestratorMcpFailure]),
  dependencies: [...dependencies, ThreadManagementService.ThreadManagementService],
})
  .annotate(Tool.Title, "Call plugin tool")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const PluginToolsToolkit = Toolkit.make(PluginToolsListTool, PluginToolCallTool);
