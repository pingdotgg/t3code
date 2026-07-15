/**
 * UnifiedSubAgentToolHandler - Effect layer handler for the UnifiedSubAgentTool.
 *
 * This handler wires the UnifiedSubAgentTool into the Effect layer system
 * so it can be registered with providers.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { UnifiedSubAgentToolkit } from "./UnifiedSubAgentTool.ts";
import {
  handleList,
  handleSpawn,
  handleSend,
  handleWait,
  handleWorkflow,
} from "./UnifiedSubAgentHandlers.ts";
import { UniversalSubAgentCoordinatorLive } from "./UniversalSubAgentCoordinator.ts";
import { SubAgentProviderRegistryLive } from "./SubAgentProviderRegistry.ts";
import { ConcurrencyLimitsLive } from "./ConcurrencyLimits.ts";
import { WorkflowEngineLive } from "./workflows/WorkflowEngine.ts";
import { WorkflowStorageLive } from "./workflows/WorkflowStorage.ts";
import type { UniversalSubAgentContext } from "./UniversalSubAgentCoordinator.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { SubAgentError } from "@t3tools/contracts";

/**
 * Handler implementation for UnifiedSubAgentTool.
 *
 * Gets context from McpInvocationContext in the Effect context.
 * This is available when the tool is invoked through MCP.
 */
const UnifiedSubAgentToolHandlers = UnifiedSubAgentToolkit.toLayer({
  subagent: (input) =>
    Effect.gen(function* () {
      // Get context from the Effect context
      const invocation = yield* McpInvocationContext.McpInvocationContext;

      const universalContext: UniversalSubAgentContext = {
        threadId: invocation.threadId,
        providerInstanceId: invocation.providerInstanceId,
        environmentId: invocation.environmentId,
      };

      switch (input.action) {
        case "list":
          return yield* handleList(universalContext);

        case "spawn":
          if (!input.providerInstanceId || !input.prompt) {
            return yield* new SubAgentError({
              reason: "dispatch-failed",
              description: "spawn requires providerInstanceId and prompt",
            });
          }
          return yield* handleSpawn(universalContext, {
            providerInstanceId: input.providerInstanceId,
            prompt: input.prompt,
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
          });

        case "send":
          if (!input.threadId || !input.prompt) {
            return yield* new SubAgentError({
              reason: "dispatch-failed",
              description: "send requires threadId and prompt",
            });
          }
          return yield* handleSend(universalContext, {
            threadId: input.threadId,
            prompt: input.prompt,
          });

        case "wait":
          if (!input.threadId) {
            return yield* new SubAgentError({
              reason: "dispatch-failed",
              description: "wait requires threadId",
            });
          }
          return yield* handleWait(universalContext, {
            threadId: input.threadId,
            ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
          });

        case "workflow":
          if (!input.workflowName) {
            return yield* new SubAgentError({
              reason: "dispatch-failed",
              description: "workflow requires workflowName",
            });
          }
          return yield* handleWorkflow(universalContext, {
            workflowName: input.workflowName,
            ...(input.workflowVariables !== undefined
              ? { variables: input.workflowVariables }
              : {}),
          });

        default: {
          const exhaustiveAction: never = input.action;
          return exhaustiveAction;
        }
      }
    }),
});

/**
 * Complete layer stack for the UnifiedSubAgentTool.
 *
 * Includes all dependencies:
 * - UniversalSubAgentCoordinator
 * - SubAgentProviderRegistry
 * - ConcurrencyLimits
 * - WorkflowEngine
 * - WorkflowStorage
 */
export const UnifiedSubAgentToolHandlerLive = UnifiedSubAgentToolHandlers.pipe(
  Layer.provide(UniversalSubAgentCoordinatorLive),
  Layer.provide(SubAgentProviderRegistryLive),
  Layer.provide(ConcurrencyLimitsLive),
  Layer.provide(WorkflowEngineLive),
  Layer.provide(WorkflowStorageLive),
);
