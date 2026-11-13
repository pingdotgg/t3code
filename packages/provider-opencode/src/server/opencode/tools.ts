/**
 * OpenCode tool part field helpers.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { openCodeCommandFailed, openCodeToolTurnItem } from "../toolItems.ts";
import {
  dateTimeFromEpoch,
  recordString,
  recordValue,
} from "./protocol.ts";

export function openCodeBoundaryAfterProviderTurn(
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  selectedProviderTurnId: OrchestrationV2ProviderTurn["id"],
): string | undefined {
  const selected = providerTurns.find((turn) => turn.id === selectedProviderTurnId);
  if (selected === undefined) return undefined;
  return providerTurns
    .filter((turn) => turn.ordinal > selected.ordinal)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((turn) => turn.nativeTurnRef?.nativeId)
    .find((nativeId): nativeId is string => nativeId !== null && nativeId !== undefined);
}

export function toolStatus(part: ToolPart): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly item: OrchestrationV2TurnItem["status"];
} {
  switch (part.state.status) {
    case "pending":
      return { node: "pending", item: "pending" };
    case "running":
      return { node: "running", item: "running" };
    case "completed":
      return openCodeCommandFailed(part.tool, part.state.metadata)
        ? { node: "failed", item: "failed" }
        : { node: "completed", item: "completed" };
    case "error":
      return { node: "failed", item: "failed" };
  }
}

export function toolInput(part: ToolPart): Record<string, unknown> {
  return part.state.input;
}

export function toolOutput(part: ToolPart): string | undefined {
  if (part.state.status === "completed") return part.state.output;
  if (part.state.status === "error") return part.state.error;
  return undefined;
}

export function toolStartedAt(part: ToolPart, now: DateTime.Utc): DateTime.Utc {
  return dateTimeFromEpoch(
    part.state.status === "pending" ? undefined : part.state.time.start,
    now,
  );
}

export function toolCompletedAt(part: ToolPart, now: DateTime.Utc): DateTime.Utc | null {
  return part.state.status === "completed" || part.state.status === "error"
    ? dateTimeFromEpoch(part.state.time.end, now)
    : null;
}

export function toolTitle(part: ToolPart): string | null {
  return part.state.status === "running" || part.state.status === "completed"
    ? (part.state.title ?? null)
    : null;
}

export function toolModel(part: ToolPart): string | null {
  const metadata =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error"
      ? part.state.metadata
      : undefined;
  const model = recordValue(metadata, "model");
  const providerId = recordString(model, "providerID", "providerId");
  const modelId = recordString(model, "modelID", "modelId", "id");
  return providerId !== undefined && modelId !== undefined ? `${providerId}/${modelId}` : null;
}

export function taskSessionId(part: ToolPart): string | null {
  const metadata =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error"
      ? part.state.metadata
      : undefined;
  return recordString(metadata, "sessionId", "sessionID") ?? null;
}
