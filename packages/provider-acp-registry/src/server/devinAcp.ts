import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";
import * as Schema from "effect/Schema";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";

const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const ACP_AUTH_REQUIRED_CODE = -32000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeDevinSessionUpdate(
  notification: AcpSchema.SessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const meta = record("_meta" in update ? update._meta : undefined);
  const parentAgentId = record(meta?.["cognition.ai/subagent_context"])?.parentAgentId;
  const routed =
    typeof parentAgentId === "string" && parentAgentId !== "root"
      ? { ...notification, sessionId: parentAgentId }
      : notification;
  const messageId = meta?.["cognition.ai/streamingMessageId"];
  if (
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk") &&
    typeof messageId === "string"
  ) {
    return { ...routed, update: { ...update, messageId } };
  }
  return routed;
}

export function normalizeDevinToolCall(tool: AcpToolCallState): AcpToolCallState {
  const name = record(tool.data.meta)?.["cognition.ai/inferenceToolName"];
  return typeof name === "string" && (!tool.title || tool.title === "Tool")
    ? { ...tool, title: name }
    : tool;
}

export function extractDevinSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const meta = record(tool.data.meta);
  const completed = record(meta?.["cognition.ai/subagent_completed"]);
  const started = record(meta?.["cognition.ai/subagent_started"]);
  const data = completed ?? started;
  if (typeof data?.agentId !== "string") return undefined;
  return {
    nativeTaskId: data.agentId,
    childSessionId: data.agentId,
    prompt: typeof started?.task === "string" ? started.task : "",
    title: typeof started?.title === "string" ? started.title : null,
    model: typeof started?.model === "string" ? started.model : null,
    status: completed ? (completed.success === false ? "failed" : "completed") : "running",
    result: typeof completed?.summary === "string" ? completed.summary : null,
  };
}

// Devin's plan exit offers several allow_once options in no promised order; T3 never answers with bypass.
export function devinAnswerablePermissionOptions(
  request: AcpSchema.RequestPermissionRequest,
): ReadonlyArray<AcpSchema.PermissionOption> {
  return request.options.filter((option) => option.optionId.trim() !== "plan_bypass");
}

function devinErrorMetadata(cause: unknown):
  | {
      readonly error: AcpErrors.AcpRequestError;
      readonly errorKind: string | undefined;
      readonly retryable: boolean | undefined;
    }
  | undefined {
  if (!isAcpRequestError(cause)) return undefined;
  const data = record(cause.data);
  const rawKind = data?.["cognition.ai/errorKind"];
  const errorKind =
    typeof rawKind === "string" && rawKind.trim().length > 0 ? rawKind.trim() : undefined;
  const retryable =
    typeof data?.["cognition.ai/retryable"] === "boolean"
      ? data["cognition.ai/retryable"]
      : undefined;
  return { error: cause, errorKind, retryable };
}

export function devinPromptFailure(cause: unknown): OrchestrationV2ProviderFailure | undefined {
  const meta = devinErrorMetadata(cause);
  if (meta === undefined) return undefined;
  return makeProviderFailure({
    cause: meta.error,
    message: meta.error.errorMessage,
    code: meta.errorKind ?? String(meta.error.code),
    class: meta.errorKind === "unavailable" ? "transport_error" : "provider_error",
    ...(meta.retryable === undefined ? {} : { retryable: meta.retryable }),
  });
}

// Devin rejects `session/prompt` with `cognition.ai/retryable: true` while keeping the session intact.
export function devinResumeAfterPromptError(cause: unknown): string | undefined {
  const meta = devinErrorMetadata(cause);
  if (
    meta === undefined ||
    meta.retryable !== true ||
    meta.error.code === ACP_AUTH_REQUIRED_CODE ||
    (meta.error.method !== undefined && meta.error.method !== "session/prompt")
  ) {
    return undefined;
  }
  return "continue";
}
