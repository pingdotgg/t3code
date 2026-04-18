import {
  type RuntimeEventRawSource,
  RuntimeItemId,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";

import type { AcpPermissionRequest, AcpPlanUpdate, AcpToolCallState } from "./AcpRuntimeModel.ts";

type AcpAdapterRawSource = Extract<
  RuntimeEventRawSource,
  "acp.jsonrpc" | `acp.${string}.extension`
>;

interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

type AcpCanonicalRequestType = Extract<
  CanonicalRequestType,
  "exec_command_approval" | "file_read_approval" | "file_change_approval" | "unknown"
>;

function canonicalRequestTypeFromAcpKind(kind: string | "unknown"): AcpCanonicalRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function runtimeItemStatusFromAcpToolStatus(
  status: AcpToolCallState["status"],
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

export function makeAcpRequestOpenedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly detail: string;
  readonly args: unknown;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      detail: input.detail,
      args: input.args,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpRequestResolvedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly permissionRequest: AcpPermissionRequest;
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: canonicalRequestTypeFromAcpKind(input.permissionRequest.kind),
      decision: input.decision,
    },
  };
}

export function makeAcpPlanUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly payload: AcpPlanUpdate;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "turn.plan.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: input.payload,
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpToolCallEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const runtimeStatus = runtimeItemStatusFromAcpToolStatus(input.toolCall.status);
  return {
    type:
      input.toolCall.status === "completed" || input.toolCall.status === "failed"
        ? "item.completed"
        : "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.toolCall.toolCallId),
    payload: {
      itemType: canonicalItemTypeFromAcpToolKind(input.toolCall.kind),
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(input.toolCall.title ? { title: input.toolCall.title } : {}),
      ...(input.toolCall.detail ? { detail: input.toolCall.detail } : {}),
      ...(Object.keys(input.toolCall.data).length > 0 ? { data: input.toolCall.data } : {}),
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpAssistantItemEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId: string;
  readonly lifecycle: "item.started" | "item.completed";
}): ProviderRuntimeEvent {
  return {
    type: input.lifecycle,
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.itemId),
    payload: {
      itemType: "assistant_message",
      status: input.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
  };
}

export function makeAcpContentDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly itemId?: string;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: "assistant_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpUsageUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly size: number;
  readonly used: number;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "thread.token-usage.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      usage: {
        usedTokens: Math.max(0, Math.round(input.used)),
        maxTokens: Math.max(1, Math.round(input.size)),
      },
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}
