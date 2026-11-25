import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";
import * as AcpErrors from "effect-acp/errors";
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
      "session.compaction_complete",
      "assistant.turn_start",
      "assistant.idle",
      "tool.execution_start",
    ],
  },
};

const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);

/** Copilot keeps failing every prompt with these until its process is replaced. */
const COPILOT_LOST_SESSION_MARKERS = [
  "session event delivery failed: session not found: ",
  "session lock unavailable during is_session_generation_current: acquisition timed out",
];

export function isCopilotLostSessionError(error: unknown): boolean {
  if (!isAcpRequestError(error) || error.method !== "session/prompt" || error.code !== -32603) {
    return false;
  }
  // Older Copilot reports the cause in data.details; its native ACP layer (1.0.105) in the message.
  return [error.errorMessage, record(error.data)?.details].some(
    (text) =>
      typeof text === "string" &&
      COPILOT_LOST_SESSION_MARKERS.some((marker) => text.includes(marker)),
  );
}

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

// Autopilot ends a task with this tool, whose summary repeats the answer already shown.
const TASK_COMPLETE_TOOL = "task_complete";

type TaskCompleteUpdate = Extract<
  AcpSchema.SessionUpdate,
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

/** The arguments a task_complete call was made with, from the ACP update or Copilot's metadata. */
function taskCompleteInput(update: TaskCompleteUpdate): Record<string, unknown> {
  return { ...record(update.rawInput), ...record(record(update._meta)?.[COPILOT_META_KEY]) };
}

function isTaskCompleteTool(update: TaskCompleteUpdate): boolean {
  return (
    update.title?.trim().toLowerCase() === TASK_COMPLETE_TOOL ||
    record(update._meta)?.toolName === TASK_COMPLETE_TOOL ||
    record(record(update._meta)?.[COPILOT_META_KEY])?.toolName === TASK_COMPLETE_TOOL
  );
}

/** The summary text a task_complete call was given, from its arguments. */
function taskCompleteSummary(data: Record<string, unknown>): string | undefined {
  const summary = data.summary;
  if (typeof summary === "string") return summary;
  // Some Copilot builds pass the arguments as the JSON string the model produced.
  const args = data.arguments ?? data.args;
  if (typeof args !== "string") return undefined;
  try {
    const parsed = record(JSON.parse(args))?.summary;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Copilot's tool_call reports MCP calls and glob/grep as kind "read" under a flattened title.
type CopilotToolIdentity =
  | { readonly kind: "mcp"; readonly server: string; readonly tool: string }
  | { readonly kind: "search" };

const COPILOT_SEARCH_TOOLS = new Set(["glob", "grep", "rg"]);

interface CopilotSessionAttribution {
  delta: { readonly kind: string; readonly text: string; readonly task?: string } | undefined;
  readonly taskByAgentId: Map<string, string>;
  readonly toolIdentityByCallId: Map<string, CopilotToolIdentity>;
}

/**
 * Autopilot answers, then calls task_complete with a summary that repeats the answer, then sends
 * that summary as another assistant chunk. This tracks what the prompt has shown so the repeat
 * can be dropped, keeping state across the per-chunk attribution that is released each time.
 */
interface AnswerRepeat {
  /** Every assistant message chunk this prompt has sent. */
  shown: string;
  /** The summary of each task_complete call, by toolCallId, until the repeat it explains arrives. */
  readonly summaries: Map<string, string>;
  /** Characters of a repeated summary still to drop, so the answer shows once. */
  dropping: number;
}

function copilotToolIdentity(data: Record<string, unknown>): CopilotToolIdentity | undefined {
  const server = typeof data.mcpServerName === "string" ? data.mcpServerName.trim() : "";
  const tool = typeof data.mcpToolName === "string" ? data.mcpToolName.trim() : "";
  if (server.length > 0 && tool.length > 0) return { kind: "mcp", server, tool };
  return typeof data.toolName === "string" && COPILOT_SEARCH_TOOLS.has(data.toolName)
    ? { kind: "search" }
    : undefined;
}

export function makeCopilotSubagentRouting() {
  const sessions = new Map<string, CopilotSessionAttribution>();
  const session = (sessionId: string) => {
    let current = sessions.get(sessionId);
    if (current === undefined) {
      current = { delta: undefined, taskByAgentId: new Map(), toolIdentityByCallId: new Map() };
      sessions.set(sessionId, current);
    }
    return current;
  };
  const release = (sessionId: string, current: CopilotSessionAttribution) => {
    if (
      current.delta === undefined &&
      current.taskByAgentId.size === 0 &&
      current.toolIdentityByCallId.size === 0
    ) {
      sessions.delete(sessionId);
    }
  };

  // The answer so far survives the attribution above, which drops after each chunk.
  const answers = new Map<string, AnswerRepeat>();
  const answerFor = (sessionId: string) => {
    let current = answers.get(sessionId);
    if (current === undefined) {
      current = { shown: "", summaries: new Map(), dropping: 0 };
      answers.set(sessionId, current);
    }
    return current;
  };

  const registerExtensions = (context: AcpAdapterV2ExtensionContext) =>
    context.runtime.handleExtNotification(COPILOT_SESSION_EVENT, CopilotSessionEvent, (event) => {
      const data = event.data ?? {};
      switch (event.type) {
        case "assistant.message_delta":
        case "assistant.reasoning_delta": {
          if (typeof data.deltaContent !== "string") return Effect.void;
          const current = session(event.sessionId);
          // Copilot 1.0.114+ names a subagent's deltas only by agentId, without parentToolCallId.
          const task =
            typeof data.parentToolCallId === "string"
              ? data.parentToolCallId
              : event.agentId === undefined
                ? undefined
                : current.taskByAgentId.get(event.agentId);
          current.delta = {
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
        case "tool.execution_start": {
          const identity = copilotToolIdentity(data);
          if (identity !== undefined && typeof data.toolCallId === "string") {
            session(event.sessionId).toolIdentityByCallId.set(data.toolCallId, identity);
          }
          // Copilot's task_complete repeats the answer as its summary; remember which call said what.
          if (data.toolName === TASK_COMPLETE_TOOL && typeof data.toolCallId === "string") {
            const summary = taskCompleteSummary(data);
            if (summary !== undefined) {
              answerFor(event.sessionId).summaries.set(data.toolCallId, summary);
            }
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
        // Copilot sends no ACP compaction_update; agentId marks a subagent's own compaction.
        // Older Copilot builds report a successful compaction without `outcome`.
        case "session.compaction_complete": {
          if (
            event.agentId !== undefined ||
            data.success !== true ||
            (data.outcome !== undefined && data.outcome !== "applied")
          ) {
            return Effect.void;
          }
          return context.markSessionCompacted(event.sessionId);
        }
        // Copilot holds session/prompt while an attached async shell runs (github/copilot-cli#5293).
        case "assistant.turn_start":
        case "assistant.idle": {
          if (event.agentId !== undefined || data.aborted === true) return Effect.void;
          // The prompt's answer is settled, so the next prompt starts its own.
          if (event.type === "assistant.idle") answers.delete(event.sessionId);
          return context.reportForegroundWork({
            sessionId: event.sessionId,
            state: event.type === "assistant.idle" ? "idle" : "running",
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
    let normalized = notification;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      const delta = current.delta;
      current.delta = undefined;
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
      release(notification.sessionId, current);
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const agentId = record(record(update._meta)?.[COPILOT_META_KEY])?.agentId;
      task = typeof agentId === "string" ? current.taskByAgentId.get(agentId) : undefined;
      const identity = current.toolIdentityByCallId.get(update.toolCallId);
      if (identity !== undefined) {
        if (update.status === "completed" || update.status === "failed") {
          current.toolIdentityByCallId.delete(update.toolCallId);
          release(notification.sessionId, current);
        }
        normalized = {
          ...notification,
          update:
            identity.kind === "search"
              ? { ...update, kind: "search" }
              : {
                  ...update,
                  _meta: { ...update._meta, serverId: identity.server, toolName: identity.tool },
                },
        };
      }
    }
    return task === undefined ? normalized : { ...normalized, sessionId: childSessionId(task) };
  };

  /**
   * Autopilot pairs every task_complete with chunks that repeat the summary. When that summary is
   * already the answer shown in this prompt, the repeat is the same text twice, so it is dropped.
   */
  const ignoreSessionUpdate = (notification: AcpSchema.SessionNotification): boolean => {
    const update = notification.update;
    // This runs before normalizeSessionUpdate, so the summary is read here, not from that path.
    if (
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      isTaskCompleteTool(update)
    ) {
      const summary = taskCompleteSummary(taskCompleteInput(update));
      if (summary !== undefined) {
        answerFor(notification.sessionId).summaries.set(update.toolCallId, summary);
      }
      return false;
    }
    if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
      return false;
    }
    const current = answerFor(notification.sessionId);
    const text = update.content.text;
    if (current.dropping > 0) {
      current.dropping = Math.max(current.dropping - text.length, 0);
      return true;
    }
    for (const [toolCallId, summary] of current.summaries) {
      // Drop only a chunk of the summary already shown in full: the answer before this chunk is
      // the whole summary, and this chunk repeats part of it. A summary that differs from the
      // answer is the only place its text appears, so it is kept.
      if (summary.length === 0 || current.shown !== summary) continue;
      current.summaries.delete(toolCallId);
      current.shown = "";
      return true;
    }
    current.shown += text;
    return false;
  };

  return { registerExtensions, normalizeSessionUpdate, ignoreSessionUpdate };
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
