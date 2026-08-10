import type { ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpPermissionRequest } from "./AcpRuntimeModel.ts";

export type CopilotPermissionSelection =
  | {
      readonly _tag: "ask";
    }
  | {
      readonly _tag: "cancel";
      readonly reason?: "workspace_handoff_required";
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

function isRawGitWorktreeMutation(params: EffectAcpSchema.RequestPermissionRequest): boolean {
  const text = getPermissionText(params);
  // Block only add/move. Agents may run `git worktree remove` for cleanup; create/switch
  // still go through workspace handoff tools so thread cwd/checkpoints stay aligned.
  return /\bgit\b(?:(?![;&|]\s*git\b)[\s\S]){0,300}\bworktree\s+(?:add|move)\b/.test(text);
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

export function selectCopilotPermissionForRuntimeMode(input: {
  readonly runtimeMode: RuntimeMode;
  readonly params: EffectAcpSchema.RequestPermissionRequest;
  readonly permissionRequest: AcpPermissionRequest;
}): CopilotPermissionSelection {
  if (isRawGitWorktreeMutation(input.params)) {
    return { _tag: "cancel", reason: "workspace_handoff_required" };
  }
  if (isQuestionLikePermissionRequest(input.params)) {
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
