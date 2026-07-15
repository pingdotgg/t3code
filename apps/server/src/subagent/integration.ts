/**
 * UnifiedSubAgentToolkit - Integration layer for provider adapters.
 *
 * This module provides helper functions to integrate the UnifiedSubAgentTool
 * into any provider adapter (Codex, Claude, Cursor, etc.) with minimal changes.
 *
 * Usage in adapter:
 * 1. Import: import { createUnifiedSubAgentToolHandler } from '../../subagent/integration.ts'
 * 2. Add to tool list or handle in adapter-specific way
 * 3. Map native tool calls (like Codex collabAgent) to this handler
 */
import * as Effect from "effect/Effect";
import type { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import {
  handleList,
  handleSpawn,
  handleSend,
  handleWait,
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

export interface UnifiedSubAgentToolInput {
  readonly action: "list" | "spawn" | "send" | "wait";
  // Spawn fields
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly name?: string;
  readonly title?: string;
  // Send/Wait fields
  readonly threadId?: string;
  readonly timeoutSeconds?: number;
}

export type UnifiedSubAgentToolResult =
  | SubAgentListResult
  | SubAgentSpawnResult
  | SubAgentSendResult
  | SubAgentWaitResult;

/**
 * Create a handler for the UnifiedSubAgentTool.
 *
 * Call this in your adapter with the current thread and provider context.
 */
export const createUnifiedSubAgentToolHandler = (context: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}) => {
  return (input: UnifiedSubAgentToolInput): Effect.Effect<UnifiedSubAgentToolResult, any> => {
    switch (input.action) {
      case "list":
        return handleList(context);

      case "spawn": {
        if (!input.providerInstanceId || !input.prompt) {
          return Effect.fail({
            _tag: "SubAgentError",
            reason: "dispatch-failed",
            description: "spawn requires providerInstanceId and prompt",
          });
        }
        return handleSpawn(context, {
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
        return handleSend(context, {
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
        return handleWait(context, {
          threadId: input.threadId as ThreadId,
          timeoutSeconds: input.timeoutSeconds,
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

/**
 * Helper to check if a tool call is for the unified sub-agent system.
 */
export function isUnifiedSubAgentToolCall(toolName: string): boolean {
  return toolName === "subagent" || toolName === "unified_subagent";
}

/**
 * Helper to extract action from various tool call formats.
 */
export function extractSubAgentAction(
  input: unknown,
): "list" | "spawn" | "send" | "wait" | null {
  if (
    typeof input === "object" &&
    input !== null &&
    "action" in input &&
    typeof input.action === "string"
  ) {
    const action = input.action;
    if (action === "list" || action === "spawn" || action === "send" || action === "wait") {
      return action;
    }
  }
  return null;
}
