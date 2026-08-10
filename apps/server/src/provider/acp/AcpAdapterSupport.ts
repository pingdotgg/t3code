import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/**
 * Permission option matching the decision, chosen by ACP `kind` rather than
 * by option id.
 *
 * Option ids are agent-defined — Cursor spells them `allow-once` while
 * kiro-cli spells them `allow_once` — but `kind` is part of the spec, so
 * matching on it works for any agent. Returns `undefined` when the agent did
 * not offer an option for that decision, which callers report as a cancelled
 * outcome rather than guessing.
 */
export function selectAcpPermissionOptionIdByKind(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

/**
 * Option to select when a thread runs in full-access mode: prefer a
 * session-wide allow so the agent stops asking, falling back to a one-shot
 * allow.
 */
export function selectAcpAutoApprovedPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectAcpPermissionOptionIdByKind(request, "acceptForSession") ??
    selectAcpPermissionOptionIdByKind(request, "accept")
  );
}
