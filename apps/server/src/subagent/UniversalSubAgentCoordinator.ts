/**
 * UniversalSubAgentCoordinator - Cross-provider sub-agent orchestration
 * through the existing MCP coordinator.
 *
 * Callers use a smaller provider-neutral context. Internally, this service
 * constructs a complete capability-bearing MCP scope and preserves the
 * existing coordinator's authorization and lifecycle behavior.
 */
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type SubAgentError,
  type ThreadId,
  type SubAgentListResult,
  type SubAgentSendInput,
  type SubAgentSendResult,
  type SubAgentSpawnInput,
  type SubAgentSpawnResult,
  type SubAgentWaitInput,
  type SubAgentWaitResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  SubAgentCoordinator,
  SubAgentCoordinatorLive,
} from "../mcp/toolkits/agents/SubAgentCoordinator.ts";

/**
 * Simple context for universal sub-agent operations.
 * The wrapper turns this into a complete MCP invocation scope internally.
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
const createMcpScope = (context: UniversalSubAgentContext) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return {
      environmentId: context.environmentId,
      threadId: context.threadId,
      providerSessionId: `universal-subagent-${context.threadId}`,
      providerInstanceId: context.providerInstanceId,
      capabilities: new Set(["agents" as const]),
      issuedAt: now,
      expiresAt: now + 3600000, // 1 hour
    };
  });

const makeUniversalSubAgentCoordinator = Effect.gen(function* () {
  // Delegate to the existing SubAgentCoordinator but with proper scopes
  const subAgentCoordinator = yield* SubAgentCoordinator;

  const list: UniversalSubAgentCoordinatorShape["list"] = (context) =>
    Effect.gen(function* () {
      const scope = yield* createMcpScope(context);
      return yield* subAgentCoordinator.list(scope);
    });

  const spawn: UniversalSubAgentCoordinatorShape["spawn"] = (context, input) =>
    Effect.gen(function* () {
      const scope = yield* createMcpScope(context);
      return yield* subAgentCoordinator.spawn(scope, input);
    });

  const send: UniversalSubAgentCoordinatorShape["send"] = (context, input) =>
    Effect.gen(function* () {
      const scope = yield* createMcpScope(context);
      return yield* subAgentCoordinator.send(scope, input);
    });

  const wait: UniversalSubAgentCoordinatorShape["wait"] = (context, input) =>
    Effect.gen(function* () {
      const scope = yield* createMcpScope(context);
      return yield* subAgentCoordinator.wait(scope, input);
    });

  return UniversalSubAgentCoordinator.of({ list, spawn, send, wait });
});

export const UniversalSubAgentCoordinatorLive = Layer.effect(
  UniversalSubAgentCoordinator,
  makeUniversalSubAgentCoordinator,
).pipe(Layer.provide(SubAgentCoordinatorLive));
