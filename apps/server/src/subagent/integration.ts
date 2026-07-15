/**
 * UnifiedSubAgentToolkit - Integration layer for provider adapters.
 *
 * This module provides helper functions to integrate the UnifiedSubAgentTool
 * into any provider adapter (Codex, Claude, Cursor, Grok, etc.) with minimal changes.
 *
 * Usage in adapter:
 * 1. Import: import { createUnifiedSubAgentToolHandler } from '../../subagent/integration.ts'
 * 2. Add to tool list or handle in adapter-specific way
 * 3. Map native tool calls (like Codex collabAgent) to this handler
 */
import * as Effect from "effect/Effect";
import type { ThreadId, ProviderInstanceId, EnvironmentId } from "@t3tools/contracts";
import {
  handleList,
  handleSpawn,
  handleSend,
  handleWait,
  handleWorkflow,
} from "./UnifiedSubAgentHandlers.ts";
import type {
  SubAgentListResult,
  SubAgentSpawnInput,
  SubAgentSpawnResult,
  SubAgentSendInput,
  SubAgentSendResult,
  SubAgentWaitInput,
  SubAgentWaitResult,
} from "@t3tools/contracts";
import type { UniversalSubAgentContext } from "./UniversalSubAgentCoordinator.ts";

export interface UnifiedSubAgentToolInput {
  readonly action: "list" | "spawn" | "send" | "wait" | "workflow";
  // Spawn fields
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly name?: string;
  readonly title?: string;
  // Send/Wait fields
  readonly threadId?: string;
  readonly timeoutSeconds?: number;
  // Workflow fields
  readonly workflowName?: string;
  readonly workflowVariables?: Record<string, string>;
}

export type UnifiedSubAgentToolResult =
  | SubAgentListResult
  | SubAgentSpawnResult
  | SubAgentSendResult
  | SubAgentWaitResult
  | { workflowId: string; status: string; summary: string };

/**
 * Create a handler for the UnifiedSubAgentTool.
 *
 * Call this in your adapter with the current thread, provider, and environment context.
 * 
 * NOTE: environmentId is required (not optional like in the broken PR #131).
 */
export const createUnifiedSubAgentToolHandler = (context: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly environmentId: EnvironmentId;
}) => {
  const universalContext: UniversalSubAgentContext = {
    threadId: context.threadId,
    providerInstanceId: context.providerInstanceId,
    environmentId: context.environmentId,
  };

  return (input: UnifiedSubAgentToolInput): Effect.Effect<UnifiedSubAgentToolResult, any> => {
    switch (input.action) {
      case "list":
        return handleList(universalContext);

      case "spawn": {
        if (!input.providerInstanceId || !input.prompt) {
          return Effect.fail({
            _tag: "SubAgentError",
            reason: "dispatch-failed",
            description: "spawn requires providerInstanceId and prompt",
          });
        }
        return handleSpawn(universalContext, {
          providerInstanceId: input.providerInstanceId as ProviderInstanceId,
          prompt: input.prompt,
          model: input.model,
          name: input.name,
          title: input.title,
        });
      }

      case "send": {
        if (!input.threadId || !input.prompt) {
          return Effect.fail({
            _tag: "SubAgentError",
            reason: "dispatch-failed",
            description: "send requires threadId and prompt",
          });
        }
        return handleSend(universalContext, {
          threadId: input.threadId as ThreadId,
          prompt: input.prompt,
        });
      }

      case "wait": {
        if (!input.threadId) {
          return Effect.fail({
            _tag: "SubAgentError",
            reason: "dispatch-failed",
            description: "wait requires threadId",
          });
        }
        return handleWait(universalContext, {
          threadId: input.threadId as ThreadId,
          timeoutSeconds: input.timeoutSeconds,
        });
      }

      case "workflow": {
        if (!input.workflowName) {
          return Effect.fail({
            _tag: "SubAgentError",
            reason: "dispatch-failed",
            description: "workflow requires workflowName",
          });
        }
        return handleWorkflow(universalContext, {
          workflowName: input.workflowName,
          variables: input.workflowVariables,
        });
      }

      default:
        return Effect.fail({
          _tag: "SubAgentError",
          reason: "dispatch-failed",
          description: `Unknown action: ${(input as any).action}`,
        });
    }
  };
};

/**
 * Map Codex collabAgentToolCall to UnifiedSubAgent action.
 *
 * Codex has native collab agent support that should be mapped to our
 * unified system for consistency.
 */
export function mapCodexCollabAgentToUnified(item: {
  readonly action: string;
  readonly agentId?: string;
  readonly config?: {
    readonly provider?: string;
    readonly model?: string;
    readonly prompt?: string;
  };
}): UnifiedSubAgentToolInput | null {
  switch (item.action) {
    case "spawnAgent":
      if (!item.config?.provider || !item.config?.prompt) {
        return null;
      }
      return {
        action: "spawn",
        providerInstanceId: item.config.provider,
        model: item.config.model,
        prompt: item.config.prompt,
      };

    case "waitAgent":
      if (!item.agentId) {
        return null;
      }
      return {
        action: "wait",
        threadId: item.agentId,
      };

    case "sendAgent":
      if (!item.agentId || !item.config?.prompt) {
        return null;
      }
      return {
        action: "send",
        threadId: item.agentId,
        prompt: item.config.prompt,
      };

    default:
      return null;
  }
}
