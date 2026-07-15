/**
 * UniversalSubAgentCoordinator - Cross-provider sub-agent orchestration
 * without MCP capability gates.
 *
 * Unlike SubAgentCoordinator (MCP-based), this coordinator is universally
 * available to all providers without requiring MCP capability checks.
 * It provides the same sub-agent spawning/management functionality but
 * with a simpler context model that doesn't depend on MCP scopes.
 *
 * This enables the UnifiedSubAgentTool to work across all providers without
 * needing to create fake MCP scopes.
 */
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  RuntimeTaskId,
  SUB_AGENT_MAX_SPAWN_DEPTH,
  sanitizeSubAgentName,
  SubAgentError,
  ThreadId,
  type TurnId,
  type ModelSelection,
  type OrchestrationThread,
  type RuntimeMode,
  type SubAgentListResult,
  type SubAgentSendInput,
  type SubAgentSendResult,
  type SubAgentSpawnInput,
  type SubAgentSpawnResult,
  type SubAgentStatus,
  type SubAgentWaitInput,
  type SubAgentWaitResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { enforceSubAgentStandardMode } from "../orchestration/subAgentModelPolicy.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { readTurnStallThresholdMs } from "../provider/turnReliabilityConfig.ts";
import { resolveEffectiveRuntimeMode } from "../orchestration/InteractionModePermissions.ts";
import { SubAgentCoordinator } from "../mcp/toolkits/agents/SubAgentCoordinator.ts";

/**
 * Simple context for universal sub-agent operations.
 * No MCP capability checks - available to all providers.
 */
export interface UniversalSubAgentContext {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
}

export interface UniversalSubAgentCoordinatorShape {
  readonly list: (context: UniversalSubAgentContext) => Effect.Effect<SubAgentListResult>;
  readonly spawn: (
    context: UniversalSubAgentContext,
    input: SubAgentSpawnInput,
  ) => Effect.Effect<SubAgentSpawnResult, SubAgentError>;
  readonly send: (
    context: UniversalSubAgentContext,
    input: SubAgentSendInput,
  ) => Effect.Effect<SubAgentSendResult, SubAgentError>;
  readonly wait: (
    context: UniversalSubAgentContext,
    input: SubAgentWaitInput,
  ) => Effect.Effect<SubAgentWaitResult, SubAgentError>;
}

export class UniversalSubAgentCoordinator extends Context.Service<
  UniversalSubAgentCoordinator,
  UniversalSubAgentCoordinatorShape
>()("t3/subagent/UniversalSubAgentCoordinator") {}

/**
 * Create a proper McpInvocationScope for the SubAgentCoordinator.
 * This avoids the "mock scope" problem from the original PR #131.
 */
const createMcpScope = (context: UniversalSubAgentContext) => {
  const now = Date.now();
  return {
    environmentId: context.environmentId,
    threadId: context.threadId,
    providerSessionId: `universal-subagent-${context.threadId}`,
    providerInstanceId: context.providerInstanceId,
    capabilities: new Set(["agents" as const]),
    issuedAt: now,
    expiresAt: now + 3600000, // 1 hour
  };
};

const makeUniversalSubAgentCoordinator = Effect.gen(function* () {
  // Delegate to the existing SubAgentCoordinator but with proper scopes
  const subAgentCoordinator = yield* SubAgentCoordinator;

  const list: UniversalSubAgentCoordinatorShape["list"] = (context) =>
    Effect.gen(function* () {
      const scope = createMcpScope(context);
      return yield* subAgentCoordinator.list(scope);
    });

  const spawn: UniversalSubAgentCoordinatorShape["spawn"] = (context, input) =>
    Effect.gen(function* () {
      const scope = createMcpScope(context);
      return yield* subAgentCoordinator.spawn(scope, input);
    });

  const send: UniversalSubAgentCoordinatorShape["send"] = (context, input) =>
    Effect.gen(function* () {
      const scope = createMcpScope(context);
      return yield* subAgentCoordinator.send(scope, input);
    });

  const wait: UniversalSubAgentCoordinatorShape["wait"] = (context, input) =>
    Effect.gen(function* () {
      const scope = createMcpScope(context);
      return yield* subAgentCoordinator.wait(scope, input);
    });

  return UniversalSubAgentCoordinator.of({ list, spawn, send, wait });
});

export const UniversalSubAgentCoordinatorLive = Layer.effect(
  UniversalSubAgentCoordinator,
  makeUniversalSubAgentCoordinator,
);
