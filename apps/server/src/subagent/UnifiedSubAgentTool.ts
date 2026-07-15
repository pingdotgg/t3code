/**
 * UnifiedSubAgentTool - Universal sub-agent tool available to all providers.
 *
 * This is a provider-neutral entry point. MCP callers still use a complete
 * capability-bearing invocation scope internally.
 *
 * Provides cross-provider sub-agent orchestration with:
 * - Provider discovery (list available providers and capabilities)
 * - Cross-provider spawning (e.g., Claude can spawn Codex/Grok sub-agents)
 * - Concurrency management (per-model and global limits)
 * - OpenCode exclusion (API credits protection)
 * - Workflow execution (JSON-based multi-agent orchestration)
 */
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  SubAgentError,
  SubAgentListResult,
  SubAgentSpawnResult,
  SubAgentSendResult,
  SubAgentWaitResult,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { UniversalSubAgentCoordinator } from "./UniversalSubAgentCoordinator.ts";
import { SubAgentProviderRegistry } from "./SubAgentProviderRegistry.ts";
import { ConcurrencyLimits } from "./ConcurrencyLimits.ts";
import { WorkflowEngine } from "./workflows/WorkflowEngine.ts";
import { WorkflowStorage } from "./workflows/WorkflowStorage.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

// Tool input combines all actions into one schema
const UnifiedSubAgentToolInput = Schema.Struct({
  action: Schema.Literals(["list", "spawn", "send", "wait", "workflow"]),
  // Spawn-specific fields
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  // Send/Wait-specific fields
  threadId: Schema.optional(ThreadId),
  timeoutSeconds: Schema.optional(Schema.Int),
  // Workflow-specific fields
  workflowName: Schema.optional(Schema.String),
  workflowVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

// Tool result is a union of all action results
const UnifiedSubAgentToolResult = Schema.Union([
  SubAgentListResult,
  SubAgentSpawnResult,
  SubAgentSendResult,
  SubAgentWaitResult,
  Schema.Struct({
    workflowId: Schema.String,
    status: Schema.String,
    summary: Schema.String,
  }),
]);

/**
 * UnifiedSubAgentTool - Single tool for all sub-agent operations.
 *
 * Available to all providers without MCP capability gates.
 */
export const UnifiedSubAgentTool = Tool.make("subagent", {
  description: `Spawn and manage sub-agents across any configured provider.

Actions:
- 'list': Discover available providers (models, capabilities, status) and see your spawned sub-agents. OpenCode is excluded (uses API credits).
- 'spawn': Create a sub-agent on ANY provider, including different ones from yourself (e.g., Claude can spawn Codex/Grok, vice versa). Returns immediately with threadId.
- 'send': Send follow-up prompt to an existing sub-agent. Use after sub-agent completes a turn.
- 'wait': Wait for sub-agent turn to complete and get the final result. Blocks up to timeoutSeconds (default 60, max 600).

Usage pattern:
1. Call with action='list' to see available providers and their models
2. Call with action='spawn' to create sub-agent on any provider (remember threadId)
3. Call with action='wait' to get result
4. Optionally call with action='send' for follow-ups

Concurrency limits enforced per model:
- Cheap models (haiku, gpt-4o-mini): 30 concurrent
- Moderate models (sonnet, gpt-4o): 10 concurrent
- Expensive models (fable, opus, gpt-5.5): 5 concurrent
- Global max: 50 total sub-agents

Example:
{
  "action": "list"
}
Then:
{
  "action": "spawn",
  "providerInstanceId": "grok-default",
  "model": "grok-4.5",
  "prompt": "Analyze this code for security issues"
}
Then:
{
  "action": "wait",
  "threadId": "<threadId from spawn>"
}`,

  parameters: UnifiedSubAgentToolInput,
  success: UnifiedSubAgentToolResult,
  failure: SubAgentError,
  dependencies: [
    UniversalSubAgentCoordinator,
    SubAgentProviderRegistry,
    ConcurrencyLimits,
    WorkflowEngine,
    WorkflowStorage,
    Crypto.Crypto,
    FileSystem.FileSystem,
    McpInvocationContext.McpInvocationContext,
  ],
})
  .annotate(Tool.Title, "Spawn and manage sub-agents")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true); // spawn/send modify state

export type UnifiedSubAgentToolInput = typeof UnifiedSubAgentToolInput.Type;
export type UnifiedSubAgentToolResult = typeof UnifiedSubAgentToolResult.Type;

export const UnifiedSubAgentToolkit = Toolkit.make(UnifiedSubAgentTool);
