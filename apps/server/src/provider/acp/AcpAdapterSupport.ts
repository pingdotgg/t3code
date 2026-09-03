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
const ACP_PERMISSION_KINDS_BY_DECISION = {
  accept: ["allow_once"],
  acceptForSession: ["allow_always", "allow_once"],
  acceptAlways: ["allow_always", "allow_once"],
  decline: ["reject_once"],
  cancel: [],
} as const satisfies Readonly<
  Record<ProviderApprovalDecision, ReadonlyArray<EffectAcpSchema.PermissionOptionKind>>
>;

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
        provider === "acp" && error.code === -32000
          ? `${error.message} Authenticate with the configured CLI outside T3 Code, then retry.`
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
