/**
 * CopilotSdkRuntimeEvents — translate `@github/copilot-sdk` session events into
 * T3 Code's canonical `ProviderRuntimeEvent` stream.
 *
 * The SDK emits a typed event union (`assistant.message_delta`,
 * `tool.execution_*`, `session.idle`, …). These builders map the subset the UI
 * renders into the same `ProviderRuntimeEvent` shapes the ACP path produced, so
 * nothing downstream (web timeline, orchestration) needs to change. Provenance
 * is tagged `copilot.sdk.event` / `copilot.sdk.permission`.
 *
 * @module provider/sdk/CopilotSdkRuntimeEvents
 */
import {
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  type RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  type TurnId,
} from "@t3tools/contracts";
import type {
  PermissionRequest,
  ToolExecutionCompleteData,
  ToolExecutionStartData,
} from "@github/copilot-sdk";

export interface CopilotSdkEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface CopilotSdkEventBase {
  readonly stamp: CopilotSdkEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
}

/** Maps an SDK tool's name/metadata to a canonical timeline item type. */
export function toolItemTypeFromSdk(data: {
  readonly toolName: string;
  readonly mcpServerName?: string;
}): ToolLifecycleItemType {
  if (data.mcpServerName) return "mcp_tool_call";
  const name = data.toolName.toLowerCase();
  if (/(bash|shell|exec|run_|terminal|command)/.test(name)) return "command_execution";
  if (/(write|edit|str_replace|create_file|apply_patch|patch|delete|move|rename)/.test(name)) {
    return "file_change";
  }
  // Only actual web fetches/searches — `grep`/`find`/`glob` are local code
  // searches and fall through to the generic tool-call type.
  if (/(web_?search|web_?fetch|fetch_?url|http|browse)/.test(name)) return "web_search";
  if (/(view_image|image)/.test(name)) return "image_view";
  return "dynamic_tool_call";
}

/** Maps an SDK permission-request kind to a canonical approval request type. */
export function requestTypeFromSdkPermissionKind(kind: string): CanonicalRequestType {
  switch (kind) {
    case "shell":
      return "exec_command_approval";
    case "write":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

/** Short human-readable detail line for a permission request, per kind. */
export function permissionDetailFromSdk(request: PermissionRequest): string | undefined {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText?.trim() || request.intention?.trim();
    case "write":
      return request.fileName?.trim() || request.intention?.trim();
    case "read":
      return request.path?.trim() || request.intention?.trim();
    case "mcp":
      return `${request.serverName}/${request.toolName}`.trim();
    default:
      return undefined;
  }
}

export function makeSdkContentDeltaEvent(
  input: CopilotSdkEventBase & {
    readonly itemId?: string;
    readonly text: string;
    readonly streamKind: RuntimeContentStreamKind;
    readonly method?: string;
    readonly rawPayload: unknown;
  },
): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    payload: {
      streamKind: input.streamKind,
      delta: input.text,
    },
    raw: {
      source: "copilot.sdk.event",
      method: input.method ?? "session.event",
      payload: input.rawPayload,
    },
  };
}

export function makeSdkAssistantItemEvent(
  input: CopilotSdkEventBase & {
    readonly itemId: string;
    readonly lifecycle: "item.started" | "item.completed";
  },
): ProviderRuntimeEvent {
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

export function makeSdkToolStartEvent(
  input: CopilotSdkEventBase & {
    readonly data: ToolExecutionStartData;
    readonly itemType: ToolLifecycleItemType;
  },
): ProviderRuntimeEvent {
  const itemType = input.itemType;
  const title = input.data.mcpToolName?.trim() || input.data.toolName.trim();
  return {
    // A tool's first appearance is the canonical `item.started`; progress
    // updates map to `item.updated` and completion to `item.completed`.
    type: "item.started",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.data.toolCallId),
    payload: {
      itemType,
      status: "inProgress",
      ...(title ? { title } : {}),
      ...(input.data.arguments !== undefined ? { data: input.data.arguments } : {}),
    },
    raw: {
      source: "copilot.sdk.event",
      method: "tool.execution_start",
      payload: input.data,
    },
  };
}

export function makeSdkToolProgressEvent(
  input: CopilotSdkEventBase & {
    readonly toolCallId: string;
    readonly itemType: ToolLifecycleItemType;
    readonly detail: string;
    readonly rawPayload: unknown;
  },
): ProviderRuntimeEvent {
  return {
    type: "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.toolCallId),
    payload: {
      itemType: input.itemType,
      status: "inProgress",
      ...(input.detail.trim() ? { detail: input.detail.trim() } : {}),
    },
    raw: {
      source: "copilot.sdk.event",
      method: "tool.execution_progress",
      payload: input.rawPayload,
    },
  };
}

export function makeSdkToolCompleteEvent(
  input: CopilotSdkEventBase & {
    readonly data: ToolExecutionCompleteData;
    readonly itemType: ToolLifecycleItemType;
  },
): ProviderRuntimeEvent {
  return {
    type: "item.completed",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.make(input.data.toolCallId),
    payload: {
      itemType: input.itemType,
      status: input.data.success ? "completed" : "failed",
      ...(input.data.error?.message?.trim() ? { detail: input.data.error.message.trim() } : {}),
    },
    raw: {
      source: "copilot.sdk.event",
      method: "tool.execution_complete",
      payload: input.data,
    },
  };
}

export function makeSdkRequestOpenedEvent(
  input: CopilotSdkEventBase & {
    readonly requestId: RuntimeRequestId;
    readonly request: PermissionRequest;
    readonly detail: string | undefined;
  },
): ProviderRuntimeEvent {
  const detail = input.detail?.trim();
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: requestTypeFromSdkPermissionKind(input.request.kind),
      ...(detail ? { detail } : {}),
      args: input.request,
    },
    raw: {
      source: "copilot.sdk.permission",
      method: "permission.requested",
      payload: input.request,
    },
  };
}

export function makeSdkRequestResolvedEvent(
  input: CopilotSdkEventBase & {
    readonly requestId: RuntimeRequestId;
    readonly request: PermissionRequest;
    readonly decision: ProviderApprovalDecision;
  },
): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: requestTypeFromSdkPermissionKind(input.request.kind),
      decision: input.decision,
    },
  };
}
