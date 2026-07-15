/**
 * UnifiedSubAgentHandlers - Handlers for the universal sub-agent tool.
 *
 * These handlers expose a provider-agnostic entry point while the universal
 * coordinator delegates through the existing MCP coordinator with a complete,
 * capability-bearing invocation scope.
 */
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import type {
  SubAgentListResult,
  SubAgentSpawnInput,
  SubAgentSpawnResult,
  SubAgentSendInput,
  SubAgentSendResult,
  SubAgentWaitInput,
  SubAgentWaitResult,
} from "@t3tools/contracts";
import { SubAgentError } from "@t3tools/contracts";
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
 * Callers do not construct MCP scopes; the coordinator does that safely.
 */
export const handleList = (context: UniversalSubAgentContext) =>
  Effect.gen(function* () {
    const coordinator = yield* UniversalSubAgentCoordinator;
    const registry = yield* SubAgentProviderRegistry;
    const concurrency = yield* ConcurrencyLimits;

    // Get spawnable providers (excludes OpenCode)
    const providers = yield* registry.listSpawnableProviders({
      excludeApiCredits: true,
      requireAvailable: true,
    });

    // Get list from coordinator
    const result = yield* coordinator.list(context);

    for (const agent of result.agents) {
      if (agent.status !== "running") {
        yield* concurrency.release(agent.threadId);
      }
    }

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
      return yield* new SubAgentError({
        reason: "provider-not-found",
        description: `Provider ${input.providerInstanceId} not found.`,
      });
    }

    if (!providerInfo.spawnable) {
      return yield* new SubAgentError({
        reason: "provider-not-spawnable",
        description: `Provider ${input.providerInstanceId} is not available for spawning.`,
      });
    }

    // Resolve model
    const model = input.model ?? providerInfo.models[0]?.slug;
    if (!model) {
      return yield* new SubAgentError({
        reason: "model-not-resolved",
        description: `No model available for provider ${input.providerInstanceId}.`,
      });
    }

    const reservationId = yield* concurrency.reserve(input.providerInstanceId, model);
    const result = yield* coordinator
      .spawn(context, { ...input, model })
      .pipe(Effect.onError(() => concurrency.release(reservationId)));
    yield* concurrency.bindReservation(reservationId, result.threadId);
    yield* concurrency.monitorTurn(
      result.threadId,
      coordinator
        .list(context)
        .pipe(
          Effect.map(
            (listed) =>
              listed.agents.find((agent) => agent.threadId === result.threadId)?.status ?? "error",
          ),
        ),
    );

    return result satisfies SubAgentSpawnResult;
  });

/**
 * Send follow-up prompt to sub-agent.
 */
export const handleSend = (context: UniversalSubAgentContext, input: SubAgentSendInput) =>
  Effect.gen(function* () {
    const coordinator = yield* UniversalSubAgentCoordinator;
    const concurrency = yield* ConcurrencyLimits;
    const listed = yield* coordinator.list(context);
    const agent = listed.agents.find((candidate) => candidate.threadId === input.threadId);
    if (!agent) {
      return yield* new SubAgentError({
        reason: "thread-not-found",
        description: `Sub-agent ${input.threadId} was not created by this session.`,
      });
    }

    const reservationId = yield* concurrency.reserve(agent.providerInstanceId, agent.model);
    const result = yield* coordinator
      .send(context, input)
      .pipe(Effect.onError(() => concurrency.release(reservationId)));
    yield* concurrency.bindReservation(reservationId, result.threadId);
    yield* concurrency.monitorTurn(
      result.threadId,
      coordinator
        .list(context)
        .pipe(
          Effect.map(
            (next) =>
              next.agents.find((candidate) => candidate.threadId === result.threadId)?.status ??
              "error",
          ),
        ),
    );
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
      yield* concurrency.release(input.threadId);
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
    const crypto = yield* Crypto.Crypto;

    // Load workflow (builtin or user-defined)
    const workflow = isBuiltinWorkflow(input.workflowName)
      ? yield* loadBuiltinWorkflow(input.workflowName)
      : yield* storage.load(input.workflowName);

    // Create execution context
    const variables = new Map(Object.entries(input.variables ?? {}));
    const workflowId = `wf-${yield* crypto.randomUUIDv4}`;

    const executionContext = {
      workflowId,
      callerThreadId: context.threadId,
      callerProviderInstanceId: context.providerInstanceId,
      environmentId: context.environmentId,
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
  }).pipe(
    Effect.mapError(
      (error) =>
        new SubAgentError({
          reason: "dispatch-failed",
          description: `Workflow execution failed: ${"message" in error ? String(error.message) : String(error)}`,
        }),
    ),
  );
