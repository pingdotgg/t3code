/**
 * Projects OpenCode 2 stream activity into T3 conversation events and thread rosters.
 */
import type { OrchestrationV2ConversationMessage, OrchestrationV2ExecutionNode, OrchestrationV2ProviderFailure, OrchestrationV2ProviderSession, OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { readableProviderErrorMessage } from "../../providerErrorMessage.ts";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import {
  openCodeCommandFailed,
  openCodeToolTurnItem,
} from "../../toolItems.ts";
import { ref, text } from "./protocol.ts";
import type { ActiveTurn, EventOf, ThreadState, TurnTerminal } from "./types.ts";
import type { State } from "./state.ts";

export const makeProjections = (
  deps: State,
) => {
  const {
    driver,
    emit,
    hasBackground,
    idAllocator,
    itemBase,
    live,
    ordinalOf,
    runningCalls,
  } = deps;

  const emitProviderThread = Effect.fnUntraced(function* (state: ThreadState) {
    const pendingBackgroundWork = hasBackground(state);
    state.publishedBackgroundWork = pendingBackgroundWork;
    yield* emit({
      type: "provider_thread.updated",
      driver,
      providerThread: state.providerThread,
      pendingBackgroundWork,
    });
  });

  const setSessionStatus =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null,
    ) {
      // The session is shared by every thread on this instance and is persisted
      // once per attached thread, so a repeat of the same state is not worth a write.
      if (live.session.status === status && live.session.lastError === lastError) return;
      live.session = { ...live.session, status, lastError, updatedAt: yield* DateTime.now };
      yield* emit({ type: "provider_session.updated", driver, providerSession: live.session });
    });

  const emitNode = (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    kind: OrchestrationV2ExecutionNode["kind"],
    status: OrchestrationV2ExecutionNode["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
  ) =>
    emit({
      type: "node.updated",
      driver,
      node: {
        id: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: ref(nativeId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    });

  const emitText = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    data: {
      readonly assistantMessageID: string;
      readonly ordinal: number;
      readonly text?: string;
    },
    kind: "text" | "reasoning",
    update: (current: string) => string,
    completed = "text" in data,
  ) {
    const nativeId = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
    const updatedAt = yield* DateTime.now;
    const entry = turn.texts.get(nativeId) ?? {
      block: data,
      kind,
      startedAt: updatedAt,
      text: "",
    };
    entry.text = update(entry.text);
    if (completed) turn.texts.delete(nativeId);
    else turn.texts.set(nativeId, entry);
    if (entry.text.length === 0) return;
    const status = completed ? "completed" : "running";
    const completedAt = completed ? updatedAt : null;
    const nodeKind = kind === "text" ? "assistant_message" : "reasoning";
    yield* emitNode(state, turn, nativeId, nodeKind, status, entry.startedAt, completedAt);
    const base = itemBase(state, turn, nativeId, status, entry.startedAt, completedAt, updatedAt);
    if (kind === "reasoning") {
      yield* emit({
        type: "turn_item.updated",
        driver,
        turnItem: { ...base, type: "reasoning", text: entry.text, streaming: !completed },
      });
      return;
    }
    const messageId = idAllocator.derive.messageFromProviderItem({
      driver,
      nativeItemId: nativeId,
    });
    const message: OrchestrationV2ConversationMessage = {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId: turn.input.threadId,
      runId: turn.input.runId,
      nodeId: base.nodeId,
      role: "assistant",
      text: entry.text,
      attachments: [],
      streaming: !completed,
      createdAt: entry.startedAt,
      updatedAt,
    };
    yield* emit({ type: "message.updated", driver, message });
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...base,
        type: "assistant_message",
        messageId,
        text: entry.text,
        streaming: !completed,
      },
    });
  });

  const emitTool = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    id: string,
    status: "running" | "completed" | "failed" | "interrupted",
    result?: { readonly output: string | undefined; readonly metadata: unknown },
  ) {
    const tool = turn.tools.get(id);
    if (tool === undefined) return;
    const updatedAt = yield* DateTime.now;
    const startedAt = turn.startedAt.get(id) ?? updatedAt;
    const completedAt = status === "running" ? null : updatedAt;
    const nativeId = `${turn.scope}${id}`;
    const settled =
      status === "completed" && openCodeCommandFailed(tool.name, result?.metadata)
        ? "failed"
        : status;
    yield* emitNode(state, turn, nativeId, "tool_call", settled, startedAt, completedAt);
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: openCodeToolTurnItem(
        itemBase(state, turn, nativeId, settled, startedAt, completedAt, updatedAt),
        {
          name: tool.name,
          input: tool.input,
          output: result?.output,
          completedMetadata: status === "completed" ? result?.metadata : undefined,
        },
      ),
    });
  });

  const emitCompaction = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    status: "running" | "completed" | "failed" | "interrupted",
    summary?: string,
  ) {
    const compaction = turn.compaction;
    if (compaction === undefined) return;
    const updatedAt = yield* DateTime.now;
    const completedAt = status === "running" ? null : updatedAt;
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: {
        ...itemBase(
          state,
          turn,
          compaction.nativeId,
          status,
          compaction.startedAt,
          completedAt,
          updatedAt,
        ),
        nodeId: turn.input.rootNodeId,
        type: "compaction",
        driver,
        title:
          status === "running"
            ? "Compacting context"
            : status === "completed"
              ? "Context compacted"
              : status === "failed"
                ? "Compaction failed"
                : "Compaction interrupted",
        ...(summary === undefined || summary.length === 0 ? {} : { summary }),
      },
    });
    if (status !== "running") turn.compaction = undefined;
  });

  const emitRetry = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    status: "running" | TurnTerminal["status"],
    failure?: OrchestrationV2ProviderFailure,
  ) {
    const retry = turn.retry;
    if (retry === undefined) return;
    yield* emit({
      type: "turn_item.updated",
      driver,
      turnItem: makeProviderRetryTurnItem({
        driver,
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: turn.input.rootNodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        itemOrdinal: ordinalOf(turn, `terminal-failure:${turn.providerTurn.id}`),
        failure: failure ?? retry.failure,
        retry: retry.retry,
        status,
        startedAt: retry.startedAt,
        updatedAt: yield* DateTime.now,
      }),
    });
  });

  const updateRetry = Effect.fnUntraced(function* (
    state: ThreadState,
    turn: ActiveTurn,
    { attempt, error }: Pick<EventOf<"session.retry.scheduled">["data"], "attempt" | "error">,
    delayMs: number,
  ) {
    turn.retry = {
      retry: {
        // OpenCode counts the first request as attempt 1, so its first retry is attempt 2.
        attempt: Math.max(1, attempt - 1),
        maxAttempts: null,
        retryDelayMs: Math.max(0, Math.trunc(delayMs)),
      },
      failure: makeProviderFailure({
        message: readableProviderErrorMessage(error.message, error.status, error.response?.body),
        code: error.type,
        class: "provider_error",
        retryable: true,
      }),
      startedAt: turn.retry?.startedAt ?? (yield* DateTime.now),
    };
    yield* emitRetry(state, turn, "running");
  });

  const emitProviderTurn = (
    state: ThreadState,
    turn: ActiveTurn,
    providerTurn: OrchestrationV2ProviderTurn,
  ) => {
    state.providerTurns.set(String(providerTurn.id), providerTurn);
    return emit({
      type: "provider_turn.updated",
      driver,
      threadId: turn.input.threadId,
      providerTurn,
    });
  };

  const syncRoster = Effect.fnUntraced(function* (state: ThreadState) {
    const roster = runningCalls(state)
      .filter((call) => call.background)
      .map((call) => ({
        taskId: call.nativeId,
        kind: "subagent" as const,
        ...(call.title?.trim() ? { description: call.title.trim() } : {}),
        ...(call.child?.subagent === undefined
          ? {}
          : { childThreadId: call.child.subagent.appThread.id }),
      }));
    const current = state.providerThread.pendingBackgroundTasks ?? [];
    if (
      state.publishedBackgroundWork === hasBackground(state) &&
      current.length === roster.length &&
      current.every(
        (task, index) =>
          task.taskId === roster[index]?.taskId &&
          task.description === roster[index]?.description &&
          (task.kind === "subagent" ? task.childThreadId : undefined) ===
            roster[index]?.childThreadId,
      )
    ) {
      return;
    }
    state.providerThread = {
      ...state.providerThread,
      pendingBackgroundTasks: roster,
      updatedAt: yield* DateTime.now,
    };
    yield* emitProviderThread(state);
  });

  const syncRosterAncestors = Effect.fnUntraced(function* (state: ThreadState) {
    let current: ThreadState | undefined = state;
    while (current !== undefined) {
      yield* syncRoster(current);
      current = current.subagent?.call.state;
    }
  });

  return {
    emitProviderThread,
    setSessionStatus,
    emitNode,
    emitText,
    emitTool,
    emitCompaction,
    emitRetry,
    updateRetry,
    emitProviderTurn,
    syncRoster,
    syncRosterAncestors,
  };
};

export type Projections = ReturnType<typeof makeProjections>;
