/**
 * UnifiedSubAgentHandlers - Handlers for the universal sub-agent tool.
 *
 * These handlers use UniversalSubAgentCoordinator (not the MCP-based
 * SubAgentCoordinator) to provide cross-provider sub-agent orchestration
 * without capability gates.
 */
import * as Effect from "effect/Effect";
import type {
  SubAgentListResult,
  SubAgentSpawnInput,
  SubAgentSpawnResult,
  SubAgentSendInput,
  SubAgentSendResult,
  SubAgentWaitInput,
  SubAgentWaitResult,
} from "@t3tools/contracts";
import {
  UniversalSubAgentCoordinator,
  type UniversalSubAgentContext,
} from "./UniversalSubAgentCoordinator.ts";
import { SubAgentProviderRegistry } from "./SubAgentProviderRegistry.ts";
import { ConcurrencyLimits } from "./ConcurrencyLimits.ts";
import { WorkflowEngine } from "./workflows/WorkflowEngine.ts";
import { WorkflowStorage } from "./workflows/WorkflowStorage.ts";
import { loadBuiltinWorkflow, isBuiltinWorkflow } from "./workflows/BuiltinWorkflows.ts";

/**
 * List available providers and spawned sub-agents.
 * No capability check required - universally available.
 */
export const handleList = (context: UniversalSubAgentContext) =>
  Effect.gen(function* () {
    const coordinator = yield* UniversalSubAgentCoordinator;
    const registry = yield* SubAgentProviderRegistry;

    // Get spawnable providers (excludes OpenCode)
    const providers = yield* registry.listSpawnableProviders({
      excludeApiCredits: true,
      requireAvailable: true,
    });

    // Get list from coordinator
    const result = yield* coordinator.list(context);

    // Enhance with our registry info
    return {
      ...result,
      providers: result.providers.map((p) => {
        const info = providers.find((pi) => pi.instanceId === p.instanceId);
        return {
          ...p,
          spawnable: info?.spawnable ?? p.spawnable,
        };
      }),
    } satisfies SubAgentListResult;
  });

/**
 * Spawn a sub-agent on any provider.
 * Checks concurrency limits before spawning.
 */
export const handleSpawn = (context: UniversalSubAgentContext, input: SubAgentSpawnInput) =>
  Effect.gen(function* () {
    const coordinator = yield* UniversalSubAgentCoordinator;
    const registry = yield* SubAgentProviderRegistry;
    const concurrency = yield* ConcurrencyLimits;

    // Validate provider
    const providerInfo = yield* registry.getProviderInfo(input.providerInstanceId);
    if (!providerInfo) {
      return yield* Effect.fail({
        _tag: "SubAgentError",
        reason: "provider-not-found",
        description: `Provider ${input.providerInstanceId} not found.`,
      });
    }

    if (!providerInfo.spawnable) {
      return yield* Effect.fail({
        _tag: "SubAgentError",
        reason: "provider-not-spawnable",
        description: `Provider ${input.providerInstanceId} is not available for spawning.`,
      });
    }

    // Resolve model
    const model = input.model ?? providerInfo.models[0]?.slug;
    if (!model) {
      return yield* Effect.fail({
        _tag: "SubAgentError",
        reason: "model-not-resolved",
        description: `No model available for provider ${input.providerInstanceId}.`,
      });
    }

    // Check concurrency limits
    yield* concurrency.checkCanSpawn(input.providerInstanceId, model);

    // Spawn via coordinator
    const result = yield* coordinator.spawn(context, input);

    // Register in concurrency tracker
    yield* concurrency.registerSpawn(result.threadId, result.providerInstanceId, result.model);

    return result satisfies SubAgentSpawnResult;
  });

/**
 * Send follow-up prompt to sub-agent.
 */
export const handleSend = (context: UniversalSubAgentContext, input: SubAgentSendInput) =>
  Effect.gen(function* () {
    const coordinator = yield* UniversalSubAgentCoordinator;
    const result = yield* coordinator.send(context, input);
    return result satisfies SubAgentSendResult;
  });

/**
 * Wait for sub-agent turn completion.
 */
export const handleWait = (context: UniversalSubAgentContext, input: SubAgentWaitInput) =>
  Effect.gen(function* () {
    const coordinator = yield* UniversalSubAgentCoordinator;
    const concurrency = yield* ConcurrencyLimits;

    const result = yield* coordinator.wait(context, input);

    // Unregister from concurrency tracker if terminal
    if (result.status !== "running") {
      yield* concurrency.unregisterSpawn(input.threadId);
    }

    return result satisfies SubAgentWaitResult;
  });

/**
 * Execute a workflow by name.
 */
export const handleWorkflow = (
  context: UniversalSubAgentContext,
  input: { workflowName: string; variables?: Record<string, string> },
) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    const storage = yield* WorkflowStorage;

    // Load workflow (builtin or user-defined)
    const workflow = isBuiltinWorkflow(input.workflowName)
      ? yield* loadBuiltinWorkflow(input.workflowName)
      : yield* storage.load(input.workflowName);

    // Create execution context
    const variables = new Map(Object.entries(input.variables ?? {}));
    const workflowId = `wf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const executionContext = {
      workflowId,
      callerThreadId: context.threadId,
      callerProviderInstanceId: context.providerInstanceId,
      variables,
    };

    // Execute workflow
    const result = yield* engine.execute(workflow, executionContext);

    return {
      workflowId: result.workflowId,
      status: result.status,
      summary: `Workflow '${result.name}' ${result.status}`,
      metrics: result.metrics,
      phases: result.phases.map((p) => ({
        id: p.phaseId,
        status: p.status,
        taskCount: p.tasks.length,
      })),
    };
  });
