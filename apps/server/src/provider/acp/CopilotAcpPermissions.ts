import type {
  ProviderApprovalDecision,
  RuntimeMode,
  ToolLifecycleItemType,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpPermissionRequest } from "./AcpRuntimeModel.ts";

export type CopilotPermissionSelection =
  | {
      readonly _tag: "ask";
    }
  | {
      readonly _tag: "cancel";
    }
  | {
      readonly _tag: "select";
      readonly optionId: string;
    };

type PermissionOptionKind = EffectAcpSchema.PermissionOptionKind;

const FULL_ACCESS_ALLOW_KINDS = ["allow_always", "allow_once"] as const;
const AUTO_ACCEPT_EDITS_ALLOW_KINDS = ["allow_once", "allow_always"] as const;
const ACCEPT_ONCE_KINDS = ["allow_once", "allow_always"] as const;
const ACCEPT_FOR_SESSION_KINDS = ["allow_always", "allow_once"] as const;
const REJECT_KINDS = ["reject_once", "reject_always"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTextValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getPermissionText(params: EffectAcpSchema.RequestPermissionRequest): string {
  const contentText = params.toolCall.content
    ?.flatMap((entry) => {
      if (entry.type !== "content") {
        return [];
      }
      const content = entry.content;
      return content.type === "text" ? [content.text] : [];
    })
    .join(" ");
  return [
    params.toolCall.kind,
    params.toolCall.title,
    contentText,
    typeof params.toolCall.rawInput === "string"
      ? params.toolCall.rawInput
      : JSON.stringify(params.toolCall.rawInput ?? ""),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function isQuestionLikePermissionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  const rawInput = isRecord(params.toolCall.rawInput) ? params.toolCall.rawInput : undefined;
  const toolName =
    normalizeTextValue(rawInput?.toolName) ??
    normalizeTextValue(rawInput?.name) ??
    normalizeTextValue(rawInput?.tool);
  const normalizedToolName = toolName?.toLowerCase();
  const text = getPermissionText(params);
  return (
    normalizedToolName === "ask" ||
    normalizedToolName === "question" ||
    text.includes("?") ||
    text.includes("question") ||
    text.includes("ask user") ||
    text.includes("exit plan") ||
    text.includes("exit planning")
  );
}

function findOptionIdByKind(
  request: EffectAcpSchema.RequestPermissionRequest,
  kinds: ReadonlyArray<PermissionOptionKind>,
): string | undefined {
  for (const kind of kinds) {
    const option = request.options.find((entry) => entry.kind === kind);
    const optionId = option?.optionId.trim();
    if (optionId) {
      return optionId;
    }
  }
  return undefined;
}

function selectedOption(optionId: string | undefined): CopilotPermissionSelection {
  return optionId ? { _tag: "select", optionId } : { _tag: "ask" };
}

function selectedOptionOrCancel(optionId: string | undefined): CopilotPermissionSelection {
  return optionId ? { _tag: "select", optionId } : { _tag: "cancel" };
}

function isAutoAcceptEditsPermission(permissionRequest: AcpPermissionRequest): boolean {
  return (
    permissionRequest.kind === "edit" ||
    permissionRequest.kind === "write" ||
    permissionRequest.kind === "delete" ||
    permissionRequest.kind === "move" ||
    permissionRequest.toolCall?.itemType === "file_change"
  );
}

function isKnownAutoApprovablePermission(input: {
  readonly params: EffectAcpSchema.RequestPermissionRequest;
  readonly permissionRequest: AcpPermissionRequest;
}): boolean {
  if (isQuestionLikePermissionRequest(input.params)) {
    return false;
  }

  switch (input.permissionRequest.kind) {
    case "read":
    case "edit":
    case "write":
    case "delete":
    case "move":
    case "search":
    case "fetch":
    case "execute":
      return true;
    default:
      break;
  }

  const itemType: ToolLifecycleItemType | undefined = input.permissionRequest.toolCall?.itemType;
  return (
    itemType === "command_execution" || itemType === "file_change" || itemType === "web_search"
  );
}

export function selectCopilotPermissionForRuntimeMode(input: {
  readonly runtimeMode: RuntimeMode;
  readonly params: EffectAcpSchema.RequestPermissionRequest;
  readonly permissionRequest: AcpPermissionRequest;
}): CopilotPermissionSelection {
  if (!isKnownAutoApprovablePermission(input)) {
    return { _tag: "ask" };
  }

  switch (input.runtimeMode) {
    case "full-access":
      return selectedOption(findOptionIdByKind(input.params, FULL_ACCESS_ALLOW_KINDS));
    case "auto-accept-edits":
      return isAutoAcceptEditsPermission(input.permissionRequest)
        ? selectedOption(findOptionIdByKind(input.params, AUTO_ACCEPT_EDITS_ALLOW_KINDS))
        : { _tag: "ask" };
    case "approval-required":
      return { _tag: "ask" };
  }
}

export function selectCopilotPermissionForDecision(input: {
  readonly params: EffectAcpSchema.RequestPermissionRequest;
  readonly decision: ProviderApprovalDecision;
}): CopilotPermissionSelection {
  switch (input.decision) {
    case "accept":
      return selectedOptionOrCancel(findOptionIdByKind(input.params, ACCEPT_ONCE_KINDS));
    case "acceptForSession":
      return selectedOptionOrCancel(findOptionIdByKind(input.params, ACCEPT_FOR_SESSION_KINDS));
    case "decline": {
      const optionId = findOptionIdByKind(input.params, REJECT_KINDS);
      return optionId ? { _tag: "select", optionId } : { _tag: "cancel" };
    }
    case "cancel":
      return { _tag: "cancel" };
  }
}
