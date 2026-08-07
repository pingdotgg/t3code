import type {
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
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export type AgentOrchestrationError = AgentProfileError | AgentRunError;

/**
 * Provider-neutral application boundary behind T3's Agent MCP toolkit.
 * Provider adapters only inject MCP; all policy and lifecycle decisions stay here.
 */
export class AgentOrchestration extends Context.Service<
  AgentOrchestration,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: AgentMcpListInput,
    ) => Effect.Effect<AgentMcpListOutput, AgentOrchestrationError>;
    readonly spawn: (
      scope: McpInvocationScope,
      input: AgentMcpSpawnInput,
    ) => Effect.Effect<AgentMcpSpawnOutput, AgentOrchestrationError>;
    readonly status: (
      scope: McpInvocationScope,
      input: AgentMcpStatusInput,
    ) => Effect.Effect<AgentMcpStatusOutput, AgentOrchestrationError>;
    readonly wait: (
      scope: McpInvocationScope,
      input: AgentMcpWaitInput,
    ) => Effect.Effect<AgentMcpWaitOutput, AgentOrchestrationError>;
    readonly result: (
      scope: McpInvocationScope,
      input: AgentMcpResultInput,
    ) => Effect.Effect<AgentMcpResultOutput, AgentOrchestrationError>;
    readonly send: (
      scope: McpInvocationScope,
      input: AgentMcpSendInput,
    ) => Effect.Effect<AgentMcpSendOutput, AgentOrchestrationError>;
    readonly cancel: (
      scope: McpInvocationScope,
      input: AgentMcpCancelInput,
    ) => Effect.Effect<AgentMcpCancelOutput, AgentOrchestrationError>;
    readonly integrate: (
      scope: McpInvocationScope,
      input: AgentMcpIntegrateInput,
    ) => Effect.Effect<AgentMcpIntegrateOutput, AgentOrchestrationError>;
  }
>()("t3/agents/AgentOrchestration") {}
