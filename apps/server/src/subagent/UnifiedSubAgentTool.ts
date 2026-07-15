/**
 * UnifiedSubAgentTool - Universal sub-agent tool available to all providers.
 *
 * Unlike the MCP-based agent_* tools that require capability grants, this tool
 * is universally available to every provider (Claude, Codex, Cursor, etc.)
 * without any MCP restrictions.
 *
 * Provides cross-provider sub-agent orchestration with:
 * - Provider discovery (list available providers and capabilities)
 * - Cross-provider spawning (e.g., Claude can spawn Codex sub-agents)
 * - Concurrency management (per-model and global limits)
 * - OpenCode exclusion (API credits protection)
 * - Workflow execution (JSON-based multi-agent orchestration)
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";
import {
  SubAgentError,
  SubAgentListResult,
  SubAgentSpawnInput,
  SubAgentSpawnResult,
  SubAgentSendInput,
  SubAgentSendResult,
  SubAgentWaitInput,
  SubAgentWaitResult,
} from "@t3tools/contracts";
import { SubAgentProviderRegistry } from "./SubAgentProviderRegistry.ts";
import { ConcurrencyLimits } from "./ConcurrencyLimits.ts";
import { WorkflowEngine } from "./workflows/WorkflowEngine.ts";
import { WorkflowStorage } from "./workflows/WorkflowStorage.ts";

// Tool input combines all actions into one schema
const UnifiedSubAgentToolInput = Schema.Struct({
  action: Schema.Literals(["list", "spawn", "send", "wait", "workflow"]).annotate({
    description:
      "Action to perform: 'list' to discover providers, 'spawn' to create sub-agent, 'send' for follow-up, 'wait' to await completion, 'workflow' to execute multi-agent workflow",
  }),
  // Spawn-specific fields
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  // Send/Wait-specific fields
  threadId: Schema.optional(Schema.String),
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
- 'spawn': Create a sub-agent on ANY provider, including different ones from yourself (e.g., Claude can spawn Codex, vice versa). Returns immediately with threadId.
- 'send': Send follow-up prompt to an existing sub-agent. Use after sub-agent completes a turn.
- 'wait': Wait for sub-agent turn to complete and get the final result. Blocks up to timeoutSeconds (default 60, max 600).

Usage pattern:
1. Call with action='list' to see available providers
2. Call with action='spawn' to create sub-agent (remember threadId)
3. Call with action='wait' to get result
4. Optionally call with action='send' for follow-ups
5. Call with action='workflow' and workflowName to execute multi-agent workflows

Concurrency limits enforced per model:
- Cheap models (haiku, gpt-4o-mini): 30 concurrent
- Moderate models (sonnet, gpt-4o): 10 concurrent
- Expensive models (fable, opus, gpt-5.5): 5 concurrent
- Global max: 50 total sub-agents

Built-in workflows: 'code-review', 'parallel-search', 'multi-model-eval'`,

  parameters: UnifiedSubAgentToolInput,
  success: UnifiedSubAgentToolResult,
  failure: SubAgentError,
  dependencies: [SubAgentProviderRegistry, ConcurrencyLimits],
})
  .annotate(Tool.Title, "Spawn and manage sub-agents")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true); // spawn/send modify state

export type UnifiedSubAgentToolInput = typeof UnifiedSubAgentToolInput.Type;
export type UnifiedSubAgentToolResult = typeof UnifiedSubAgentToolResult.Type;

/**
 * Handler for the UnifiedSubAgentTool.
 *
 * Routes actions to the appropriate sub-agent coordinator methods.
 */
export const handleUnifiedSubAgentTool = (input: UnifiedSubAgentToolInput) =>
  Effect.gen(function* () {
    const registry = yield* SubAgentProviderRegistry;
    const concurrency = yield* ConcurrencyLimits;

    switch (input.action) {
      case "list": {
        // List available providers and spawned agents
        const providers = yield* registry.listSpawnableProviders({
          excludeApiCredits: true,
          requireAvailable: true,
        });

        return {
          providers: providers.map((p) => ({
            instanceId: p.instanceId,
            driver: p.driver,
            displayName: p.displayName,
            status: p.status,
            authStatus: "authenticated" as const, // TODO: get from provider
            spawnable: p.spawnable,
            models: p.models.map((m) => m.slug),
            isCaller: false, // TODO: detect caller
          })),
          agents: [], // TODO: integrate with SubAgentCoordinator
        } satisfies SubAgentListResult;
      }

      case "spawn": {
        // Validate required fields
        if (!input.providerInstanceId || !input.prompt) {
          return yield* new SubAgentError({
            reason: "dispatch-failed",
            description: "spawn action requires providerInstanceId and prompt",
          });
        }

        // Check provider exists and is spawnable
        const providerInfo = yield* registry.getProviderInfo(input.providerInstanceId);
        if (!providerInfo) {
          return yield* new SubAgentError({
            reason: "provider-not-found",
            description: `Provider ${input.providerInstanceId} not found. Use action='list' to see available providers.`,
          });
        }

        if (!providerInfo.spawnable) {
          return yield* new SubAgentError({
            reason: "provider-not-spawnable",
            description: `Provider ${input.providerInstanceId} (${providerInfo.driver}) is not spawnable (status: ${providerInfo.status}). Use action='list' to find available providers.`,
          });
        }

        // Resolve model
        const model = input.model ?? providerInfo.models[0]?.slug;
        if (!model) {
          return yield* new SubAgentError({
            reason: "model-not-resolved",
            description: `Provider ${input.providerInstanceId} has no models. Specify a model explicitly.`,
          });
        }

        // Check concurrency limits
        yield* concurrency.checkCanSpawn(input.providerInstanceId, model);

        // TODO: Actually spawn the sub-agent via SubAgentCoordinator
        // For now, return a placeholder
        const threadId = `thread-${Date.now()}`;

        yield* concurrency.registerSpawn(threadId, input.providerInstanceId, model);

        return {
          threadId,
          providerInstanceId: input.providerInstanceId,
          model,
          title: input.title ?? input.name ?? "Sub-agent task",
          ...(input.name ? { name: input.name } : {}),
          status: "running" as const,
        } satisfies SubAgentSpawnResult;
      }

      case "send": {
        if (!input.threadId || !input.prompt) {
          return yield* new SubAgentError({
            reason: "dispatch-failed",
            description: "send action requires threadId and prompt",
          });
        }

        // TODO: Integrate with SubAgentCoordinator
        return {
          threadId: input.threadId,
          status: "running" as const,
        } satisfies SubAgentSendResult;
      }

      case "wait": {
        if (!input.threadId) {
          return yield* new SubAgentError({
            reason: "dispatch-failed",
            description: "wait action requires threadId",
          });
        }

        // TODO: Integrate with SubAgentCoordinator
        return {
          threadId: input.threadId,
          status: "completed" as const,
          finalText: "Placeholder result",
          lastActivityAt: new Date().toISOString(),
          stalled: false,
        } satisfies SubAgentWaitResult;
      }
    }
  });
