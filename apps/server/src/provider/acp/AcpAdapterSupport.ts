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

export function acpPermissionOutcome(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): string | undefined {
  const desiredKinds =
    decision === "acceptForSession"
      ? (["allow_always"] as const)
      : decision === "accept"
        ? (["allow_once"] as const)
        : (["reject_once", "reject_always"] as const);
  for (const kind of desiredKinds) {
    const byKind = options.find((option) => option.kind === kind)?.optionId;
    if (byKind?.trim()) return byKind;
  }

  // Some pre-standard ACP agents used kebab-case ids while newer agents,
  // including OMP, use snake_case ids. `kind` is authoritative, but retain
  // both id spellings for agents that omit it.
  const aliases = new Set(desiredKinds.flatMap((kind) => [kind, kind.replaceAll("_", "-")]));
  return options.find((option) => aliases.has(option.optionId))?.optionId;
}
