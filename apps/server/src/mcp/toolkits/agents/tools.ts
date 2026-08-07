import {
  AgentMcpCancelInput,
  AgentMcpCancelOutput,
  AgentMcpIntegrateInput,
  AgentMcpIntegrateOutput,
  AgentMcpListInput,
  AgentMcpListOutput,
  AgentMcpResultInput,
  AgentMcpResultOutput,
  AgentMcpSendInput,
  AgentMcpSendOutput,
  AgentMcpSpawnInput,
  AgentMcpSpawnOutput,
  AgentMcpStatusInput,
  AgentMcpStatusOutput,
  AgentMcpWaitInput,
  AgentMcpWaitOutput,
  AgentProfileError,
  AgentRunError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as AgentOrchestration from "../../../agents/AgentOrchestration.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  AgentOrchestration.AgentOrchestration,
];

const failure = Schema.Union([
  AgentProfileError,
  AgentRunError,
  McpInvocationContext.McpCapabilityUnavailableError,
]);

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const AgentListTool = readonlyTool(
  Tool.make("agent_list", {
    description:
      "List T3 Agent profiles available to this thread. Use this before spawning; profile ids are T3-owned and work across providers.",
    parameters: AgentMcpListInput,
    success: AgentMcpListOutput,
    failure,
    dependencies,
  }).annotate(Tool.Title, "List T3 agents"),
);

export const AgentSpawnTool = Tool.make("agent_spawn", {
  description:
    "Launch a bounded T3 child agent asynchronously with a named profile. Returns immediately with a run id; use agent_wait or agent_status to observe it.",
  parameters: AgentMcpSpawnInput,
  success: AgentMcpSpawnOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Spawn T3 agent")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const AgentStatusTool = readonlyTool(
  Tool.make("agent_status", {
    description: "Read the current lifecycle state and usage of one T3 Agent run.",
    parameters: AgentMcpStatusInput,
    success: AgentMcpStatusOutput,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Get agent status"),
);

export const AgentWaitTool = readonlyTool(
  Tool.make("agent_wait", {
    description:
      "Wait until any requested T3 Agent run advances beyond the supplied revision cursor, or until the bounded timeout expires.",
    parameters: AgentMcpWaitInput,
    success: AgentMcpWaitOutput,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Wait for agents"),
);

export const AgentResultTool = readonlyTool(
  Tool.make("agent_result", {
    description:
      "Read paginated output, final message, diff, and usage from a T3 Agent run without copying its entire child thread into context.",
    parameters: AgentMcpResultInput,
    success: AgentMcpResultOutput,
    failure,
    dependencies,
  }).annotate(Tool.Title, "Read agent result"),
);

export const AgentSendTool = Tool.make("agent_send", {
  description:
    "Send a follow-up instruction to an existing T3 Agent run while preserving its child-thread context.",
  parameters: AgentMcpSendInput,
  success: AgentMcpSendOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Message agent")
  .annotate(Tool.Destructive, true);

export const AgentCancelTool = Tool.make("agent_cancel", {
  description: "Cancel an active T3 Agent run and stop its provider session.",
  parameters: AgentMcpCancelInput,
  success: AgentMcpCancelOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Cancel agent")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const AgentIntegrateTool = Tool.make("agent_integrate", {
  description:
    "Integrate an isolated-worktree Agent run into its target thread after reviewing the run result. Shared-workspace runs require no integration.",
  parameters: AgentMcpIntegrateInput,
  success: AgentMcpIntegrateOutput,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Integrate agent work")
  .annotate(Tool.Destructive, true);

export const AgentToolkit = Toolkit.make(
  AgentListTool,
  AgentSpawnTool,
  AgentStatusTool,
  AgentWaitTool,
  AgentResultTool,
  AgentSendTool,
  AgentCancelTool,
  AgentIntegrateTool,
);
