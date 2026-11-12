import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";

const ToolSearchTool = Tool.make(McpToolExposure.TOOL_SEARCH, {
  description:
    "Load T3 Code tools you do not have yet, then call them by name. Search by name or purpose: threads (t3_thread_*), projects (t3_project_*), worktrees, preview_* browser, device_*, html_preview/html_render, schedule_task, pull requests and guides, attachments, request_secret, environment links. Exact names work too.",
  parameters: Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(500)) }),
  success: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, McpToolExposure.McpToolExposure],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ToolSearchToolkit = Toolkit.make(ToolSearchTool);
