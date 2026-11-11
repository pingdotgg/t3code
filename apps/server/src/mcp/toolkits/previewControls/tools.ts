import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewListResult,
  PreviewTabId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PreviewManager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
};
const PreviewListTool = Tool.make("t3_preview_list", {
  ...shared,
  description:
    "List this thread's preview tabs. Only `runtime:'server'` entries can be automated here. Others are in the user's local desktop app. Never pass a non-server `tabId` to a `preview_*` tool. Tell the user that tab is on their local desktop and this environment cannot reach it.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    ...PreviewListResult.fields,
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const PreviewCloseTool = Tool.make("t3_preview_close", {
  ...shared,
  description:
    "Close one preview tab this thread owns. Use it on a tab you opened for your own check when you finish.",
  parameters: Schema.Struct({ tabId: PreviewTabId }),
  success: Schema.Struct({}),
}).annotate(Tool.Destructive, true);
export const PreviewControlsToolkit = Toolkit.make(PreviewListTool, PreviewCloseTool);
