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

function readAcpErrorDataMessage(data: unknown): string | undefined {
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (data && typeof data === "object") {
    const maybeRecord = data as Record<string, unknown>;
    for (const key of ["message", "detail", "error"]) {
      const value = maybeRecord[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    try {
      return JSON.stringify(data);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function formatAcpRequestErrorDetail(error: EffectAcpErrors.AcpRequestError): string {
  const dataMessage = readAcpErrorDataMessage(error.data);
  if (!dataMessage) {
    return error.message;
  }
  return error.message === "Internal error" ? dataMessage : `${error.message}: ${dataMessage}`;
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
      detail: formatAcpRequestErrorDetail(error),
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

const FALLBACK_PERMISSION_OPTION_IDS = {
  accept: "allow-once",
  acceptForSession: "allow-always",
  decline: "reject-once",
} as const satisfies Record<Exclude<ProviderApprovalDecision, "cancel">, string>;

const PERMISSION_OPTION_KINDS = {
  accept: "allow_once",
  acceptForSession: "allow_always",
  decline: "reject_once",
} as const satisfies Record<
  Exclude<ProviderApprovalDecision, "cancel">,
  EffectAcpSchema.PermissionOption["kind"]
>;

export function acpPermissionOutcome(
  decision: ProviderApprovalDecision,
  options?: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): string {
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "decline": {
      const optionKind = PERMISSION_OPTION_KINDS[decision];
      const matchingOption = options?.find(
        (option) => option.kind === optionKind && option.optionId.trim().length > 0,
      );
      return matchingOption?.optionId.trim() ?? FALLBACK_PERMISSION_OPTION_IDS[decision];
    }
    default:
      return "reject-once";
  }
}
