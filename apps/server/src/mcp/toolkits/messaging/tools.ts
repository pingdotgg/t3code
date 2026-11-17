import {
  AgentInboxInput,
  AgentInboxResult,
  AgentSendInput,
  AgentSendResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AgentMessagingService from "../../AgentMessagingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AgentMessagingService.AgentMessagingService,
];

const AgentSendTool = Tool.make("agent_send", {
  description:
    "Send a durable message to an agent in this delegation family. Choose a unique messageId and reuse it unchanged when retrying. The message remains in the recipient inbox until they acknowledge it with agent_inbox.",
  parameters: AgentSendInput,
  success: AgentSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send an agent message")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const AgentInboxTool = Tool.make("agent_inbox", {
  description:
    "List delegation-family addresses and pending durable messages. Messages remain pending until acknowledgeMessageIds includes their IDs after processing.",
  parameters: AgentInboxInput,
  success: AgentInboxResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read agent messages")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const AgentMessagingToolkit = Toolkit.make(AgentSendTool, AgentInboxTool);
