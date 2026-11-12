import {
  OrchestratorMcpFailure,
  WorkFilesReceiveInput,
  WorkFilesReceiveResult,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as WorkFilesTransfer from "../../../peer/WorkFilesTransfer.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Called by a linked environment bringing a thread's files here; agents never see it. */
export const WorkFilesReceiveTool = Tool.make("t3_work_files_receive", {
  description:
    "Linked environments only: get a one-time upload for work files into a project's checkout.",
  parameters: WorkFilesReceiveInput,
  success: WorkFilesReceiveResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    WorkFilesTransfer.WorkFilesTransfer,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForLinkedEnvironments);

export const WorkFilesToolkit = Toolkit.make(WorkFilesReceiveTool);
