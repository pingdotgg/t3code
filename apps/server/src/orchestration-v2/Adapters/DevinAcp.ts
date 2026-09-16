import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import type { AcpAdapterV2SubagentUpdate } from "./AcpAdapterV2.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Devin's typed extension metadata, captured from its native ACP stream. */
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
