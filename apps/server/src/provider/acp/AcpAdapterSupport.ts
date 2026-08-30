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
const isAcpInputStreamEndedError = Schema.is(EffectAcpErrors.AcpInputStreamEndedError);
const isAcpTransportError = Schema.is(EffectAcpErrors.AcpTransportError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  // A dead process, an ended stdout, and a broken transport are all the same
  // fact from the client's side — the session is gone, not one request. An
  // in-flight request during process death surfaces as the transport error.
  if (
    isAcpProcessExitedError(error) ||
    isAcpInputStreamEndedError(error) ||
    isAcpTransportError(error)
  ) {
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

/**
 * Resolves the agent-offered permission option id for a T3 decision by option
 * kind. Ids are agent-defined (Cursor CLI 2026.08.25 offers "allow-once",
 * "allow-always", "reject-once"; other agents differ), so an id the agent did
 * not offer is a protocol violation — callers must treat `undefined` as
 * unanswerable and cancel.
 * Some agents (Grok 4.6) omit allow_always while T3 still offers "Always
 * allow this session"; that decision falls back to the allow_once option.
 */
export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const preferred = request.options.find((entry) => entry.kind === preferredKind);
  const preferredId = preferred?.optionId.trim();
  if (preferredId) {
    return preferredId;
  }
  if (decision === "acceptForSession") {
    const once = request.options.find((entry) => entry.kind === "allow_once");
    const onceId = once?.optionId.trim();
    if (onceId) {
      return onceId;
    }
  }
  return undefined;
}

function isDiffContentEntry(
  entry: EffectAcpSchema.ToolCallContent,
): entry is Extract<EffectAcpSchema.ToolCallContent, { type: "diff" }> {
  return entry.type === "diff";
}

/**
 * Renders the `diff` entries of a tool call's ACP content as one unified diff,
 * or `undefined` when the tool call carries none. ACP diffs are full-content
 * replacements (`oldText`/`newText`), so each file becomes a single
 * whole-file hunk. Consumers treat the diff as a change signal (placeholder
 * checkpoints), not as a patch to apply.
 */
export function unifiedDiffFromToolCallContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const sections: Array<string> = [];
  for (const entry of content as ReadonlyArray<EffectAcpSchema.ToolCallContent>) {
    if (!isDiffContentEntry(entry)) {
      continue;
    }
    const oldText = typeof entry.oldText === "string" ? entry.oldText : "";
    const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
    const newLines = entry.newText.length > 0 ? entry.newText.split("\n") : [];
    sections.push(
      [
        `--- ${oldText.length > 0 ? `a/${entry.path}` : "/dev/null"}`,
        `+++ b/${entry.path}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join("\n"),
    );
  }
  return sections.length > 0 ? sections.join("\n") : undefined;
}
