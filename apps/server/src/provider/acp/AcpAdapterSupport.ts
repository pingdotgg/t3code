import {
  type ProviderApprovalDecision,
  ProviderDriverKind,
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
const ACP_AUTH_REQUIRED_CODE = -32000;
const GENERIC_ACP_PROVIDER = ProviderDriverKind.make("acp");

/**
 * Detail shown when a generic ACP agent answers with the protocol's `auth_required` error.
 * T3 Code never drives the login of an externally authenticated CLI, so the remediation
 * is fixed rather than derived from the agent's wire message.
 */
export const ACP_AUTH_REQUIRED_DETAIL =
  "Authentication required. Sign in with the configured CLI outside T3 Code, then retry.";

const ACP_PERMISSION_KINDS_BY_DECISION = {
  accept: ["allow_once"],
  acceptForSession: ["allow_always", "allow_once"],
  acceptAlways: ["allow_always", "allow_once"],
  decline: ["reject_once", "reject_always"],
  cancel: [],
} as const satisfies Readonly<
  Record<ProviderApprovalDecision, ReadonlyArray<EffectAcpSchema.PermissionOptionKind>>
>;

/** Matches the ACP `auth_required` JSON-RPC error (`-32000`); accepts any failure value. */
export function isAcpAuthRequiredError(error: unknown): boolean {
  return isAcpRequestError(error) && error.code === ACP_AUTH_REQUIRED_CODE;
}

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
      detail:
        provider === GENERIC_ACP_PROVIDER && isAcpAuthRequiredError(error)
          ? ACP_AUTH_REQUIRED_DETAIL
          : error.message,
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

export function selectAcpPermissionOptionId(
  request: Pick<EffectAcpSchema.RequestPermissionRequest, "options">,
  decision: ProviderApprovalDecision,
): string | undefined {
  for (const kind of ACP_PERMISSION_KINDS_BY_DECISION[decision]) {
    const optionId = request.options.find((option) => option.kind === kind)?.optionId.trim();
    if (optionId) return optionId;
  }
  return undefined;
}
