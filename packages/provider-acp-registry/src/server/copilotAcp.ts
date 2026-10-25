import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type {
  AcpAdapterV2ExtensionContext,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";

// The opt-in raw feed identifies each chunk by the preceding assistant.*_delta task call id.

const COPILOT_META_KEY = "github.com/copilot";
const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent";

export const copilotClientCapabilitiesMeta = {
  [COPILOT_META_KEY]: {
    events: [
      "subagent.started",
      "subagent.completed",
      "subagent.failed",
      "assistant.message_delta",
      "assistant.reasoning_delta",
    ],
  },
};

const CopilotSessionEvent = Schema.Struct({
  sessionId: Schema.String,
  type: Schema.String,
  agentId: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const childSessionId = (taskToolCallId: string) => `copilot-task:${taskToolCallId}`;

interface CopilotSessionAttribution {
  delta: { readonly kind: string; readonly text: string; readonly task?: string } | undefined;
  readonly taskByAgentId: Map<string, string>;
}

export function makeCopilotSubagentRouting() {
  const sessions = new Map<string, CopilotSessionAttribution>();
  const session = (sessionId: string) => {
    let current = sessions.get(sessionId);
    if (current === undefined) {
      current = { delta: undefined, taskByAgentId: new Map() };
      sessions.set(sessionId, current);
    }
    return current;
  };
  const release = (sessionId: string, current: CopilotSessionAttribution) => {
    if (current.delta === undefined && current.taskByAgentId.size === 0) {
      sessions.delete(sessionId);
    }
  };

  const registerExtensions = (context: AcpAdapterV2ExtensionContext) =>
    context.runtime.handleExtNotification(COPILOT_SESSION_EVENT, CopilotSessionEvent, (event) => {
      const data = event.data ?? {};
      const task = typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined;
      switch (event.type) {
        case "assistant.message_delta":
        case "assistant.reasoning_delta": {
          if (typeof data.deltaContent !== "string") return Effect.void;
          session(event.sessionId).delta = {
            kind: event.type,
            text: data.deltaContent,
            ...(task === undefined ? {} : { task }),
          };
          return Effect.void;
        }
        case "subagent.started": {
          if (event.agentId !== undefined && typeof data.toolCallId === "string") {
            session(event.sessionId).taskByAgentId.set(event.agentId, data.toolCallId);
          }
          return Effect.void;
        }
        case "subagent.completed":
        case "subagent.failed": {
          const current = sessions.get(event.sessionId);
          if (current !== undefined && event.agentId !== undefined) {
            current.taskByAgentId.delete(event.agentId);
            release(event.sessionId, current);
          }
          if (typeof data.toolCallId !== "string") return Effect.void;
          // Background tasks end only here; their tool call settles at launch.
          return context.finishSubagent({
            sessionId: event.sessionId,
            childSessionId: childSessionId(data.toolCallId),
            status: event.type === "subagent.failed" ? "failed" : "completed",
            result: typeof data.error === "string" ? data.error : null,
          });
        }
        default:
          return Effect.void;
      }
    });

  const normalizeSessionUpdate = (
    notification: AcpSchema.SessionNotification,
  ): AcpSchema.SessionNotification => {
    const update = notification.update;
    const current = sessions.get(notification.sessionId);
    if (current === undefined) return notification;
    let task: string | undefined;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      const delta = current.delta;
      current.delta = undefined;
      release(notification.sessionId, current);
      const kind =
        update.sessionUpdate === "agent_message_chunk"
          ? "assistant.message_delta"
          : "assistant.reasoning_delta";
      if (
        delta?.kind === kind &&
        update.content.type === "text" &&
        update.content.text === delta.text
      ) {
        task = delta.task;
      }
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const agentId = record(record(update._meta)?.[COPILOT_META_KEY])?.agentId;
      task = typeof agentId === "string" ? current.taskByAgentId.get(agentId) : undefined;
    }
    return task === undefined ? notification : { ...notification, sessionId: childSessionId(task) };
  };

  return { registerExtensions, normalizeSessionUpdate };
}

export function extractCopilotSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const input = record(tool.data.rawInput);
  if (typeof input?.agent_type !== "string" || typeof input.prompt !== "string") return undefined;
  const output = record(tool.data.rawOutput)?.content;
  const background = input.mode === "background";
  const status =
    tool.status === "failed"
      ? "failed"
      : tool.status === "completed" && !background
        ? "completed"
        : "running";
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: childSessionId(tool.toolCallId),
    prompt: input.prompt,
    title: typeof input.description === "string" ? input.description : null,
    model: typeof input.model === "string" ? input.model : null,
    status,
    result: status !== "running" && typeof output === "string" ? output : null,
  };
}
