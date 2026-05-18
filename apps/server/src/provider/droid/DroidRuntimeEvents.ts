import { randomUUID } from "node:crypto";
import { DroidMessageType, type DroidMessage } from "@factory/droid-sdk";
import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeContentStreamKind,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { DROID_PROVIDER, type DroidContext } from "./DroidAdapterTypes.ts";
import { contentBlockText, toTokenUsageSnapshot, toToolItemType } from "./DroidSdkMappings.ts";

export const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

export function updateDroidContextSession(
  context: DroidContext,
  patch: Partial<DroidContext["session"]>,
) {
  context.session = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function makeDroidEventBase(instanceId: ProviderInstanceId) {
  return (
    context: DroidContext,
    input?: {
      turnId?: TurnId;
      itemId?: string;
      requestId?: string;
      raw?: unknown;
    },
  ) => ({
    eventId: EventId.make(randomUUID()),
    provider: DROID_PROVIDER,
    providerInstanceId: instanceId,
    threadId: context.session.threadId,
    createdAt: nowIso(),
    ...(input?.turnId ? { turnId: input.turnId } : {}),
    ...(input?.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input?.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input?.raw !== undefined
      ? { raw: { source: "droid.sdk.message" as const, payload: input.raw } }
      : {}),
  });
}

type DroidEventBase = ReturnType<typeof makeDroidEventBase>;

export async function handleDroidMessage(input: {
  readonly context: DroidContext;
  readonly turnId: TurnId;
  readonly message: DroidMessage;
  readonly eventBase: DroidEventBase;
  readonly emitNow: (event: ProviderRuntimeEvent) => Promise<void>;
}) {
  const { context, turnId, message, eventBase, emitNow } = input;
  const base = (itemId?: string) =>
    eventBase(context, { turnId, raw: message, ...(itemId ? { itemId } : {}) });

  switch (message.type) {
    case DroidMessageType.AssistantTextDelta:
    case DroidMessageType.ThinkingTextDelta: {
      const itemId = `${message.messageId}-${message.blockIndex}`;
      const streamKind: RuntimeContentStreamKind =
        message.type === DroidMessageType.AssistantTextDelta ? "assistant_text" : "reasoning_text";
      const activeItems =
        streamKind === "assistant_text"
          ? context.activeAssistantItems
          : context.activeThinkingItems;
      activeItems.set(itemId, `${activeItems.get(itemId) ?? ""}${message.text}`);
      return emitNow({
        ...base(itemId),
        type: "content.delta",
        payload: { streamKind, delta: message.text },
      });
    }
    case DroidMessageType.CreateMessage: {
      if (message.role !== "assistant") {
        return;
      }
      for (const [index, block] of message.content.entries()) {
        const text = contentBlockText(block);
        if (text.length === 0) {
          continue;
        }
        const itemId = `${message.messageId}-${index}`;
        if (block.type === "text") {
          const previousText = context.activeAssistantItems.get(itemId) ?? "";
          const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
          if (delta.length > 0) {
            await emitNow({
              ...base(itemId),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta },
            });
          }
          context.activeAssistantItems.set(itemId, text);
          continue;
        }
        if (block.type === "thinking") {
          const previousText = context.activeThinkingItems.get(itemId) ?? "";
          const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
          if (delta.length > 0) {
            await emitNow({
              ...base(itemId),
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta },
            });
          }
          context.activeThinkingItems.set(itemId, text);
        }
      }

      const firstTextIndex = message.content.findIndex((block) => block.type === "text");
      const firstTextBlock = message.content[firstTextIndex];
      const completedItemId =
        firstTextIndex >= 0 ? `${message.messageId}-${firstTextIndex}` : message.messageId;
      if (!context.activeCompletedAssistantItems.has(completedItemId)) {
        context.activeCompletedAssistantItems.add(completedItemId);
        return emitNow({
          ...base(completedItemId),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            ...(firstTextBlock ? { detail: contentBlockText(firstTextBlock) } : {}),
          },
        });
      }
      return;
    }
    case DroidMessageType.ToolUse:
      return emitNow({
        ...base(message.toolUseId),
        type: "item.started",
        payload: {
          itemType: toToolItemType(message.toolName),
          status: "inProgress",
          title: message.toolName,
          data: message.toolInput,
        },
      });
    case DroidMessageType.ToolProgress:
      return emitNow({
        ...base(message.toolUseId),
        type: "item.updated",
        payload: {
          itemType: toToolItemType(message.toolName),
          status: "inProgress",
          title: message.toolName,
          detail: message.content,
          data: message.update,
        },
      });
    case DroidMessageType.ToolResult:
      return emitNow({
        ...base(message.toolUseId),
        type: "item.completed",
        payload: {
          itemType: toToolItemType(message.toolName),
          status: message.isError ? "failed" : "completed",
          title: message.toolName,
          detail:
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        },
      });
    case DroidMessageType.WorkingStateChanged:
      return emitNow({
        ...base(),
        type: "session.state.changed",
        payload: {
          state:
            message.state === "idle"
              ? "ready"
              : message.state.includes("waiting")
                ? "waiting"
                : "running",
          detail: message,
        },
      });
    case DroidMessageType.TokenUsageUpdate:
      context.activeTokenUsage = toTokenUsageSnapshot(
        message,
        context.activeTokenUsage ?? context.activeTokenUsageBaseline,
        context.activeTokenUsageBaseline,
      );
      context.cumulativeTokenUsage = context.activeTokenUsage;
      return emitNow({
        ...base(),
        type: "thread.token-usage.updated",
        payload: { usage: context.activeTokenUsage },
      });
    case DroidMessageType.SessionTitleUpdated:
      return emitNow({
        ...base(),
        type: "thread.metadata.updated",
        payload: { name: message.title },
      });
    case DroidMessageType.SettingsUpdated:
      return emitNow({
        ...base(),
        type: "session.configured",
        payload: { config: message.settings },
      });
    case DroidMessageType.McpStatusChanged:
      return emitNow({
        ...base(),
        type: "mcp.status.updated",
        payload: { status: message },
      });
    case DroidMessageType.McpAuthRequired:
      return emitNow({
        ...base(),
        type: "auth.status",
        payload: { isAuthenticating: true, output: [message.message] },
      });
    case DroidMessageType.McpAuthCompleted:
      return emitNow({
        ...base(),
        type: "mcp.oauth.completed",
        payload: {
          success: message.outcome === "success",
          name: message.serverName,
          ...(message.outcome === "success" ? {} : { error: message.message }),
        },
      });
    case DroidMessageType.Error:
      context.activeTurnError = message.message;
      return emitNow({
        ...base(),
        type: "runtime.error",
        payload: { message: message.message, class: "provider_error" },
      });
    case DroidMessageType.TurnComplete:
      if (message.tokenUsage && !context.activeTokenUsage) {
        context.activeTokenUsage = toTokenUsageSnapshot(
          message.tokenUsage,
          context.activeTokenUsageBaseline,
          context.activeTokenUsageBaseline,
        );
        await emitNow({
          ...base(),
          type: "thread.token-usage.updated",
          payload: { usage: context.activeTokenUsage },
        });
      }
      context.cumulativeTokenUsage = context.activeTokenUsage ?? context.cumulativeTokenUsage;
      return;
    default:
      return;
  }
}
