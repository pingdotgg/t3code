import type {
  AgentHistoryEntry,
  OrchestrationGetAgentHistoryResult,
  TaskStartedPayload,
  TaskCompletedPayload,
} from "@t3tools/contracts";
import { RuntimeTaskId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { agentHistoryEntry, collectAgentHistory } from "./agentHistory.ts";

const RecordValue = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownOption(RecordValue);
/** Treat non-object extension payloads as absent rather than casting untrusted protocol data. */
function record(value: unknown) {
  const decoded = decodeRecord(value);
  return decoded._tag === "Some" ? decoded.value : {};
}
/** Keep unknown extension values out of display text. */
function text(value: unknown) {
  return typeof value === "string" ? value : "";
}
const State = Schema.Struct({
  summary: Schema.optional(
    Schema.Struct({
      parent_session_id: Schema.optional(Schema.String),
      session_kind: Schema.optional(Schema.String),
    }),
  ),
});
const UpdateEnvelope = Schema.Struct({ method: Schema.String, params: RecordValue });
const decodeUpdateEnvelope = Schema.decodeUnknownOption(UpdateEnvelope);
const Updates = Schema.Struct({
  updates: Schema.Array(Schema.Unknown),
});
export const GrokSubagentNotification = Schema.Struct({
  sessionId: Schema.String,
  update: RecordValue,
});

/** Grok's durable child id is also its subagent id; retain it for history reads. */
export function grokSubagentTask(
  notification: typeof GrokSubagentNotification.Type,
  parentSessionId: string,
):
  | { type: "task.started"; payload: TaskStartedPayload }
  | { type: "task.completed"; payload: TaskCompletedPayload }
  | undefined {
  if (notification.sessionId !== parentSessionId) return;
  const update = notification.update;
  const id = text(update.child_session_id);
  if (!id || id === parentSessionId) return;
  const linkage = {
    taskId: RuntimeTaskId.make(id),
    agentId: id,
    agentKind: "agent" as const,
    timelineBypass: true,
  };
  if (update.sessionUpdate === "subagent_spawned" && update.parent_session_id === parentSessionId) {
    return {
      type: "task.started",
      payload: {
        ...linkage,
        ...(text(update.description).trim()
          ? { description: text(update.description).trim(), title: text(update.description).trim() }
          : {}),
        ...(text(update.model).trim() ? { model: text(update.model).trim() } : {}),
      },
    };
  }
  if (update.sessionUpdate === "subagent_finished") {
    const status =
      update.status === "completed"
        ? "completed"
        : update.status === "failed"
          ? "failed"
          : "stopped";
    return {
      type: "task.completed",
      payload: {
        ...linkage,
        status,
        ...(text(update.output).trim() || text(update.error).trim()
          ? { summary: text(update.output).trim() || text(update.error).trim() }
          : {}),
      },
    };
  }
}

/** Read ACP text content without exposing non-text blocks as serialized objects. */
function contentText(value: unknown): string {
  if (!Array.isArray(value)) return text(record(value).text);
  return value
    .map((part) => {
      const item = record(part);
      return text(item.text) || text(record(item.content).text);
    })
    .filter(Boolean)
    .join("\n");
}

/** Fold ACP chunks and tool updates before paging visible entries. */
export function grokHistoryEntries(
  updates: ReadonlyArray<typeof UpdateEnvelope.Type>,
  childId: string,
): AgentHistoryEntry[] {
  const entries: AgentHistoryEntry[] = [];
  const tools = new Map<string, number>();
  let messageKind: AgentHistoryEntry["kind"] | undefined;
  for (const envelope of updates) {
    if (envelope.method !== "session/update" || envelope.params.sessionId !== childId) continue;
    const update = record(envelope.params.update);
    const type = update.sessionUpdate;
    const kind =
      type === "agent_message_chunk"
        ? "assistant"
        : type === "user_message_chunk"
          ? "user"
          : type === "agent_thought_chunk"
            ? "reasoning"
            : undefined;
    if (kind) {
      const chunk = contentText(update.content);
      if (!chunk) continue;
      const previous = entries.at(-1);
      if (messageKind === kind && previous) {
        entries[entries.length - 1] = {
          ...agentHistoryEntry(previous.id, kind, previous.title, previous.detail + chunk),
          truncated: previous.truncated || previous.detail.length + chunk.length > 8000,
        };
      } else
        entries.push(
          agentHistoryEntry(
            `${childId}:message:${entries.length}`,
            kind,
            kind === "assistant" ? "Assistant" : kind === "user" ? "User" : "Reasoning",
            chunk,
          ),
        );
      messageKind = kind;
      continue;
    }
    messageKind = undefined;
    if (type !== "tool_call" && type !== "tool_call_update") continue;
    const id = text(update.toolCallId);
    if (!id) continue;
    const index = tools.get(id);
    const previous = index === undefined ? undefined : entries[index];
    const detail =
      contentText(update.content) ||
      (update.rawOutput !== undefined
        ? JSON.stringify(update.rawOutput)
        : update.rawInput !== undefined
          ? JSON.stringify(update.rawInput)
          : (previous?.detail ?? ""));
    const normalized = agentHistoryEntry(
      `${childId}:tool:${id}`,
      update.kind === "edit" || previous?.kind === "file-edit" ? "file-edit" : "tool",
      text(update.title) || previous?.title || "Tool",
      detail,
    );
    const entry =
      previous?.truncated && detail === previous.detail
        ? { ...normalized, truncated: true }
        : normalized;
    if (index === undefined) {
      tools.set(id, entries.length);
      entries.push(entry);
    } else entries[index] = entry;
  }
  return entries;
}

/** Verify every parent link before retrieving a child’s persisted, rewind-filtered updates. */
export const readGrokAgentHistory = Effect.fn("readGrokAgentHistory")(function* <E>(input: {
  parentSessionId: string;
  agentId: string;
  cwd: string;
  offset: number;
  view?: "recent-tools" | "latest" | undefined;
  request: (method: string, params: unknown) => Effect.Effect<unknown, E>;
}) {
  const unavailable = (message: string): OrchestrationGetAgentHistoryResult => ({
    status: "unavailable",
    entries: [],
    nextOffset: null,
    message,
  });
  if (input.agentId === input.parentSessionId)
    return unavailable("Select a child agent to read its history.");
  let current = input.agentId;
  const seen = new Set<string>();
  while (current !== input.parentSessionId) {
    if (seen.has(current) || seen.size >= 32)
      return unavailable("Could not verify this agent belongs to the thread.");
    seen.add(current);
    const state = yield* input
      .request("_x.ai/session/state", { sessionId: current, cwd: input.cwd })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(State)));
    if (current === input.agentId && !state.summary?.session_kind?.startsWith("subagent"))
      return unavailable("The selected session is not a saved subagent.");
    if (!state.summary?.parent_session_id)
      return unavailable("This agent does not belong to the thread.");
    current = state.summary.parent_session_id;
  }
  // The native reader filters rewound branches. Offset is in visible rows, not raw ACP chunks.
  const response = yield* input
    .request("_x.ai/session/updates", { sessionId: input.agentId, cwd: input.cwd })
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Updates)));
  const entries = grokHistoryEntries(
    response.updates.flatMap((update) => {
      const decoded = decodeUpdateEnvelope(update);
      return decoded._tag === "Some" ? [decoded.value] : [];
    }),
    input.agentId,
  );
  const page = collectAgentHistory(input);
  for (const entry of entries) {
    if (page.add(entry)) break;
  }
  return page.result();
});
