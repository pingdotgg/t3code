import {
  SubAgentError,
  SubAgentListResult,
  SubAgentSendInput,
  SubAgentSendResult,
  SubAgentSpawnInput,
  SubAgentSpawnResult,
  SubAgentWaitInput,
  SubAgentWaitResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SubAgentCoordinator } from "./SubAgentCoordinator.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, SubAgentCoordinator];

export const AgentListTool = Tool.make("agent_list", {
  description:
    "List the coding-agent providers configured on this server (e.g. Codex, Claude, Cursor) that can run sub-agent threads via agent_spawn. Shows each instance id, driver, readiness, available model slugs, and which instance is running the current session.",
  parameters: Schema.Struct({}),
  success: SubAgentListResult,
  failure: SubAgentError,
  dependencies,
})
  .annotate(Tool.Title, "List sub-agent providers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentSpawnTool = Tool.make("agent_spawn", {
  description:
    "Spawn a sub-agent: start a new thread on any configured provider instance (including a different agent than yourself — e.g. delegate from Claude to Codex or vice versa) and send it an initial prompt. The sub-agent works in this thread's project and worktree. Returns immediately with the new threadId; use agent_wait to collect the result and agent_send for follow-up prompts. Use agent_list first to pick a spawnable providerInstanceId.",
  parameters: SubAgentSpawnInput,
  success: SubAgentSpawnResult,
  failure: SubAgentError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn sub-agent")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const AgentSendTool = Tool.make("agent_send", {
  description:
    "Send a follow-up prompt to a sub-agent thread previously created with agent_spawn. Returns immediately; use agent_wait to collect the response.",
  parameters: SubAgentSendInput,
  success: SubAgentSendResult,
  failure: SubAgentError,
  dependencies,
})
  .annotate(Tool.Title, "Prompt sub-agent")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const AgentWaitTool = Tool.make("agent_wait", {
  description:
    'Wait for a sub-agent thread (created with agent_spawn) to finish its current turn and return the final assistant message. Blocks up to timeoutSeconds (default 60, max 600); a status of "running" means the sub-agent is still working — call agent_wait again to keep waiting.',
  parameters: SubAgentWaitInput,
  success: SubAgentWaitResult,
  failure: SubAgentError,
  dependencies,
})
  .annotate(Tool.Title, "Await sub-agent result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const SubAgentToolkit = Toolkit.make(
  AgentListTool,
  AgentSpawnTool,
  AgentSendTool,
  AgentWaitTool,
);
