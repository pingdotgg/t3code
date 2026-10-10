import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type {
  AcpAdapterV2ExtensionContext,
  AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";

// Copilot CLI streams subagent text as plain `agent_message_chunk`s on the
// root session. Only its opt-in raw event feed says who wrote a chunk: each
// chunk is preceded by an `assistant.*_delta` carrying the spawning `task`
// tool call id. Both arrive inline on the same reader, in wire order, so the
// delta just before a chunk is that chunk's author.

const COPILOT_META_KEY = "github.com/copilot";
const COPILOT_SESSION_EVENT = "github.com/copilot/sessionEvent";

/** Subscribes to the raw events subagent routing needs, and nothing else. */
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
  /** The last raw delta, consumed by the chunk that follows it. */
  delta: { readonly kind: string; readonly text: string; readonly task?: string } | undefined;
  /** Running subagent id to the `task` tool call that spawned it. */
  readonly taskByAgentId: Map<string, string>;
}

/** Per adapter instance; entries are keyed by root session and drop once idle. */
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

  /** Moves a subagent's chunks and tool calls onto its own child session. */
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

/** Copilot's `task` tool launches a subagent; its id names the child session. */
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
