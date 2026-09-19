import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpInputStreamEndedError = Schema.is(EffectAcpErrors.AcpInputStreamEndedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);

// The agy_acp_server binary reports a clean model-side close and a failed agent
// rebuild as plain text (see acpErrorText for where it rides); neither string
// exists in our source. Classify them here so orchestration branches on the tag.
const cleanClosePattern = /\b1000\s*\(OK\)|failed to rebuild agent/i;
const antigravityStreamDropPattern =
  /(?:streamGenerateContent|model unreachable|doRequest: error sending request).*EOF/i;

export const ANTIGRAVITY_STREAM_DISCONNECTED_MESSAGE =
  "Antigravity lost its connection to the model. Send your message again to retry.";

// The binary's text rides on errorMessage for a JSON-RPC error response and on
// detail for a mid-RPC transport failure; other variants only carry a message.
function acpErrorText(error: EffectAcpErrors.AcpError): string {
  if (isAcpRequestError(error)) return error.errorMessage;
  if (isAcpTransportError(error)) return `${error.message} ${error.detail ?? ""}`;
  return error.message;
}

function isCleanCloseError(error: EffectAcpErrors.AcpError): boolean {
  return isAcpInputStreamEndedError(error) || cleanClosePattern.test(acpErrorText(error));
}

function isAntigravityStreamDropError(error: EffectAcpErrors.AcpError): boolean {
  return antigravityStreamDropPattern.test(acpErrorText(error));
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error) || isCleanCloseError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }

  if (provider === "antigravity" && isAntigravityStreamDropError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: ANTIGRAVITY_STREAM_DISCONNECTED_MESSAGE,
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
