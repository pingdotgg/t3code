import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  switch (error._tag) {
    case "AcpProcessExitedError":
      return new ProviderAdapterSessionClosedError({
        provider,
        threadId,
        cause: error,
      });
    case "AcpRequestError":
      return new ProviderAdapterRequestError({
        provider,
        method,
        // ACP request messages are intentional JSON-RPC protocol payloads, not arbitrary causes.
        detail: error.errorMessage,
        cause: error,
      });
    case "AcpSpawnError":
      return new ProviderAdapterRequestError({
        provider,
        method,
        detail: "ACP process could not be started.",
        cause: error,
      });
    case "AcpProtocolParseError":
      return new ProviderAdapterRequestError({
        provider,
        method,
        detail: `ACP protocol operation '${error.operation}' failed.`,
        cause: error,
      });
    case "AcpTransportError":
      return new ProviderAdapterRequestError({
        provider,
        method,
        detail: error.operation
          ? `ACP transport operation '${error.operation}' failed.`
          : "ACP transport operation failed.",
        cause: error,
      });
    case "AcpInputStreamEndedError":
      return new ProviderAdapterRequestError({
        provider,
        method,
        detail: "ACP input stream ended.",
        cause: error,
      });
  }
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

export function resolveAcpPermissionOutcome(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionResponse["outcome"] {
  const preferredKinds: ReadonlyArray<EffectAcpSchema.PermissionOption["kind"]> =
    decision === "acceptForSession"
      ? ["allow_always", "allow_once"]
      : decision === "accept"
        ? ["allow_once", "allow_always"]
        : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return { outcome: "selected", optionId: match.optionId };
    }
  }
  return { outcome: "cancelled" };
}
