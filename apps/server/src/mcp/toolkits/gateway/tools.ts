import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { T3_CALL_TOOL_NAME } from "@t3tools/shared/t3McpToolPresentation";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { McpToolCatalog, T3_HELP, TOOL_GROUP_INDEX } from "../../McpToolGroups.ts";

const HelpTool = Tool.make(T3_HELP, {
  description: `Get T3 Code tools that are not in your tool list. \`path\` is a group below, or one tool name. Returns each tool's description and input schema. Run a tool with \`${T3_CALL_TOOL_NAME}\`.\n${TOOL_GROUP_INDEX}`,
  parameters: Schema.Struct({ path: Schema.String.check(Schema.isMaxLength(200)) }),
  success: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        inputSchema: Schema.Unknown,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolCatalog],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const HelpToolkit = Toolkit.make(HelpTool);

/** McpHttpServer registers it by hand: it returns the called tool's own result, images included. */
export const CallTool = Tool.make(T3_CALL_TOOL_NAME, {
  description: `Run a T3 Code tool that is not in your tool list: a tool from \`${T3_HELP}\`, or a T3 tool your instructions name. \`arguments\` must match that tool's input schema.`,
  parameters: Schema.Struct({
    tool: Schema.String.check(Schema.isMaxLength(200)),
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.Unknown,
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);
