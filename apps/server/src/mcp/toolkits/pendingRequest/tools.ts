import {
  PendingRequestMcpFailure,
  PendingRequestMcpListInput,
  PendingRequestMcpListResult,
  PendingRequestMcpReadInput,
  PendingRequestMcpReadResult,
  PendingRequestMcpRespondInput,
  PendingRequestMcpRespondResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PendingRequestMcpService } from "../../PendingRequestMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, PendingRequestMcpService];

export const PendingRequestListTool = Tool.make("t3_pending_request_list", {
  description:
    "List pending user-input questions from direct app-owned delegated children of the calling thread. Results are bounded and never include approval requests or unrelated threads.",
  parameters: PendingRequestMcpListInput,
  success: PendingRequestMcpListResult,
  failure: PendingRequestMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List delegated user-input requests")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PendingRequestReadTool = Tool.make("t3_pending_request_read", {
  description:
    "Read one structured user-input question from a direct app-owned delegated child. Resolved and stale requests remain readable; this tool never responds or approves anything.",
  parameters: PendingRequestMcpReadInput,
  success: PendingRequestMcpReadResult,
  failure: PendingRequestMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a delegated user-input request")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PendingRequestRespondTool = Tool.make("t3_pending_request_respond", {
  description:
    "Answer a pending user-input question from a direct app-owned delegated child. Supply every exact question ID. This cannot answer approval requests, grant permissions, or target the calling agent or an unrelated thread. Acceptance is reported by a durable V2 command receipt; provider delivery may complete asynchronously.",
  parameters: PendingRequestMcpRespondInput,
  success: PendingRequestMcpRespondResult,
  failure: PendingRequestMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Answer a delegated user-input request")
  .annotate(Tool.Destructive, true);

export const PendingRequestToolkit = Toolkit.make(
  PendingRequestListTool,
  PendingRequestReadTool,
  PendingRequestRespondTool,
);
