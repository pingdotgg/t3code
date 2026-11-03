// @effect-diagnostics-next-line nodeBuiltinImport:off - deterministic event identities keep the projection pure and replayable.
import * as NodeCrypto from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  MessageId,
  NodeId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Record = Schema.Struct({
  type: Schema.String,
  uuid: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  isVisibleInTranscriptOnly: Schema.optional(Schema.Boolean),
  promptSource: Schema.optional(Schema.String),
  origin: Schema.optional(
    Schema.Struct({ kind: Schema.String, asUser: Schema.optional(Schema.Boolean) }),
  ),
  toolUseResult: Schema.optional(Schema.Unknown),
  message: Schema.optional(
    Schema.Struct({
      role: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      content: Schema.optional(
        Schema.Union([
          Schema.String,
          Schema.Array(
            Schema.Struct({
              type: Schema.String,
              text: Schema.optional(Schema.String),
              thinking: Schema.optional(Schema.String),
              id: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
              input: Schema.optional(Schema.Unknown),
              tool_use_id: Schema.optional(Schema.String),
              content: Schema.optional(Schema.Unknown),
              is_error: Schema.optional(Schema.Boolean),
            }),
          ),
        ]),
      ),
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Record));
const decodeSpawn = Schema.decodeUnknownOption(
  Schema.Struct({
    agentId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
    description: Schema.optional(Schema.String),
    resolvedModel: Schema.optional(Schema.String),
  }),
);
export function attachmentDetails(line: string, sessionId: string) {
  const record = decodeRecord(line);
  if (Option.isNone(record) || record.value.sessionId !== sessionId) return null;
  const spawn = decodeSpawn(record.value.toolUseResult);
  return {
    cwd: record.value.cwd,
    uuid: record.value.uuid,
    toolIds: Array.isArray(record.value.message?.content)
      ? record.value.message.content.flatMap((block) =>
          block.type === "tool_result" && block.tool_use_id
            ? [block.tool_use_id]
            : block.type === "tool_use" && block.id
              ? [block.id]
              : [],
        )
      : [],
    thinkingBlocks: Array.isArray(record.value.message?.content)
      ? record.value.message.content.flatMap((block, index) =>
          block.type === "thinking" && typeof block.thinking === "string" ? [index] : [],
        )
      : [],
    isPeer: record.value.origin?.kind === "peer",
    model: record.value.message?.model,
    spawn: Option.getOrNull(spawn),
  };
}

const attachmentKey = (...parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\0")).digest("hex");
export const attachmentThreadId = (home: string, session: string, agent = "") =>
  ThreadId.make(`claude-attached-${attachmentKey(home, session, agent)}`);
export const attachmentNodeId = (thread: ThreadId) => NodeId.make(`${thread}:external`);

export const attachmentEventId = (threadId: ThreadId, type: string, key: string) =>
  EventId.make(attachmentKey(threadId, type, key));

export function attachmentEvent<T extends OrchestrationV2DomainEvent["type"]>(
  threadId: ThreadId,
  type: T,
  payload: OrchestrationV2DomainEvent["payload"],
  at: DateTime.Utc,
  key: string,
): OrchestrationV2DomainEvent {
  // The event type and payload are paired at callers; metadata event variants share a schema.
  return {
    id: attachmentEventId(threadId, type, key),
    threadId,
    type,
    payload,
    occurredAt: at,
  } as OrchestrationV2DomainEvent;
}

export const attachmentReasoningId = (threadId: ThreadId, uuid: string, blockIndex: number) =>
  TurnItemId.make(`${threadId}:${uuid}:thinking:${blockIndex}`);

export function projectAttachmentLine(input: {
  sessionId: string;
  thread: OrchestrationV2AppThread;
  parent: OrchestrationV2AppThread | null;
  agentId: string | null;
  line: string;
  ordinal: number;
  includeActivity?: boolean;
  activityStatus?: "idle" | "running";
  activityKey?: string;
  previousSubagent?: OrchestrationV2Subagent | undefined;
  previousTools?: ReadonlyMap<string, OrchestrationV2TurnItem>;
  previousReasoning?: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const decoded = decodeRecord(input.line);
  if (Option.isNone(decoded)) return [];
  const record = decoded.value;
  if (
    !record.uuid ||
    !record.timestamp ||
    !record.message ||
    (record.type !== "user" && record.type !== "assistant") ||
    record.sessionId !== input.sessionId
  )
    return [];
  const parsedAt = DateTime.make(record.timestamp);
  if (Option.isNone(parsedAt)) return [];
  const at = parsedAt.value;
  const { thread, parent } = input;
  const content = record.message.content;
  const rawText =
    typeof content === "string"
      ? content
      : (content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
  const text = rawText;
  // Claude stores harness traffic using the user API role. Provenance, not API role,
  // determines whether it belongs in a human chat bubble. Never rewrite human text.
  const internal =
    record.type === "user" &&
    (record.isMeta ||
      record.isCompactSummary ||
      record.isVisibleInTranscriptOnly ||
      record.promptSource === "system" ||
      (record.origin !== undefined &&
        record.origin.kind !== "human" &&
        !(record.origin.kind === "plugin" && record.origin.asUser === true)) ||
      (record.origin === undefined &&
        /^(?:<task-notification>|<command-name>|<local-command-|\[Request interrupted by user)/.test(
          text,
        )));
  const internalTitle = record.isCompactSummary
    ? "Claude context summary"
    : record.origin?.kind === "peer"
      ? "Claude agent message"
      : record.origin?.kind === "task-notification" || text.startsWith("<task-notification>")
        ? "Claude task notification"
        : "Claude internal event";
  const events: Array<OrchestrationV2DomainEvent> = [];
  const key = attachmentKey("projection-v3", record.uuid, input.line);
  if (text) {
    const messageId = MessageId.make(`${thread.id}:${record.uuid}`);
    const role = internal
      ? ("system" as const)
      : record.type === "user"
        ? ("user" as const)
        : ("assistant" as const);
    const message = {
      id: messageId,
      threadId: thread.id,
      runId: null,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
      createdBy: internal
        ? ("system" as const)
        : role === "user"
          ? ("user" as const)
          : ("agent" as const),
      creationSource: "provider" as const,
    };
    events.push(attachmentEvent(thread.id, "message.updated", message, at, key));
    const common = {
      id: TurnItemId.make(`${messageId}:item`),
      threadId: thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: input.ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      messageId,
      text,
    };
    events.push(
      attachmentEvent(
        thread.id,
        "turn-item.updated",
        internal
          ? { ...common, type: "system_notice", title: internalTitle, message: internalTitle }
          : role === "user"
            ? {
                ...common,
                type: "user_message",
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                inputIntent: "turn_start",
                attachments: [],
              }
            : { ...common, type: "assistant_message", streaming: false },
        at,
        key,
      ),
    );
  }
  if (Array.isArray(content)) {
    for (const [blockIndex, block] of content.entries()) {
      if (
        record.type === "assistant" &&
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        const id = attachmentReasoningId(thread.id, record.uuid, blockIndex);
        const previous = input.previousReasoning?.get(id);
        const item: OrchestrationV2TurnItem = {
          id,
          threadId: thread.id,
          runId: null,
          nodeId: null,
          providerThreadId: thread.activeProviderThreadId,
          providerTurnId: null,
          nativeItemRef: {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: record.uuid,
            strength: "strong",
          },
          parentItemId: null,
          ordinal: previous?.ordinal ?? input.ordinal,
          type: "reasoning",
          title: "Thinking",
          text: block.thinking,
          streaming: false,
          status: "completed",
          startedAt: previous?.startedAt ?? at,
          completedAt: at,
          updatedAt: at,
        };
        events.push(
          attachmentEvent(
            thread.id,
            "turn-item.updated",
            item,
            at,
            `thinking-v1:${key}:${blockIndex}`,
          ),
        );
        continue;
      }
      const id =
        block.type === "tool_use"
          ? block.id
          : block.type === "tool_result"
            ? block.tool_use_id
            : undefined;
      if (!id) continue;
      const candidate = input.previousTools?.get(id);
      const previous = candidate?.type === "dynamic_tool" ? candidate : undefined;
      const result = block.type === "tool_result";
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make(`${thread.id}:tool:${id}`),
        threadId: thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: thread.activeProviderThreadId,
        providerTurnId: null,
        nativeItemRef: {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: id,
          strength: "strong",
        },
        parentItemId: null,
        ordinal: previous?.ordinal ?? input.ordinal,
        status: result
          ? block.is_error
            ? "failed"
            : "completed"
          : previous?.completedAt || previous?.status === "running"
            ? previous.status
            : "idle",
        title: block.name ?? previous?.title ?? "External tool",
        startedAt: !result ? at : (previous?.startedAt ?? at),
        completedAt: result ? at : (previous?.completedAt ?? null),
        updatedAt: !result && previous?.completedAt ? previous.updatedAt : at,
        type: "dynamic_tool",
        toolName: block.name?.trim() || previous?.toolName || null,
        input: block.input ?? previous?.input ?? null,
        ...(result
          ? { output: block.content ?? null }
          : previous?.output !== undefined
            ? { output: previous.output }
            : {}),
      };
      events.push(
        attachmentEvent(thread.id, "turn-item.updated", item, at, `tools-v1:${key}:${id}`),
      );
    }
  }
  if (input.includeActivity === false) return events;
  const activityKey = `${key}:activity-v2:${input.activityKey ?? "history"}`;
  {
    const ownNodeId = parent ? NodeId.make(`${thread.id}:root`) : attachmentNodeId(thread.id);
    const completed =
      record.type === "assistant" &&
      ["end_turn", "stop_sequence"].includes(record.message.stop_reason ?? "");
    events.push(
      attachmentEvent(
        thread.id,
        "node.updated",
        {
          id: ownNodeId,
          threadId: thread.id,
          runId: null,
          parentNodeId: null,
          rootNodeId: ownNodeId,
          kind: "root_turn",
          status: completed ? "completed" : (input.activityStatus ?? "running"),
          countsForRun: false,
          providerThreadId: thread.activeProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: completed ? at : null,
        },
        at,
        activityKey,
      ),
    );
  }
  if (parent && input.agentId) {
    const completed =
      record.type === "assistant" &&
      ["end_turn", "stop_sequence"].includes(record.message.stop_reason ?? "");
    const subagent: OrchestrationV2Subagent = {
      id: attachmentNodeId(thread.id),
      threadId: parent.id,
      runId: null,
      parentNodeId: attachmentNodeId(thread.lineage.parentThreadId ?? parent.id),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: thread.providerInstanceId,
      providerThreadId: null,
      childThreadId: thread.id,
      nativeTaskRef: {
        driver: ProviderDriverKind.make("claudeAgent"),
        nativeId: input.agentId,
        strength: "strong",
      },
      prompt: input.previousSubagent?.prompt || (record.type === "user" ? text : ""),
      title: thread.title,
      ...(!completed && input.activityStatus === "idle"
        ? { progress: "No recent activity; final outcome not recorded by Claude." }
        : {}),
      model: record.message.model ?? thread.modelSelection.model,
      status: completed ? "completed" : (input.activityStatus ?? "running"),
      result: completed ? text : null,
      startedAt: input.previousSubagent?.startedAt ?? at,
      completedAt: completed ? at : null,
      updatedAt: at,
    };
    events.push(attachmentEvent(parent.id, "subagent.updated", subagent, at, activityKey));
    events.push(
      attachmentEvent(
        parent.id,
        "node.updated",
        {
          id: subagent.id,
          threadId: parent.id,
          runId: null,
          parentNodeId: subagent.parentNodeId,
          rootNodeId: attachmentNodeId(parent.id),
          kind: "subagent",
          status: subagent.status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: subagent.nativeTaskRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: subagent.completedAt,
        },
        at,
        activityKey,
      ),
    );
  }
  return events;
}
