/**
 * Pi event emitters: provider session/thread updates, turn items, nodes, stream deltas and retries.
 */
import {
  ProviderDriverKind,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../rpc.ts";
import {
  PI_INHERIT_MODEL_SLUG,
  PI_PROVIDER,
  STREAM_FLUSH_MS,
  PI_REQUEST_TIMEOUT_MS,
  PI_SESSION_TIMEOUT_MS,
  PI_UNSOLICITED_ACTIVITY_ERROR,
  SETTLE_PROBE_MAX_ATTEMPTS,
  SETTLE_PROBE_RETRY_DELAY,
  PI_THINKING_LEVELS,
  PI_COMPACTING_PROMPT_REJECTION,
  PiProviderCapabilitiesV2,
  contentText,
  piToolOutput,
  providerRef,
  compactionTitle,
  piApprovalRequestKind,
} from "../adapter.ts";
import type {
  PiAdapterV2Options,
  PiStreamItemState,
  PiCompactionStatus,
  PiCompactionState,
  PiProviderRetryState,
  ActivePiTurn,
  PiTurnTreeRefs,
  PendingPiPrompt,
  PiPromptSend,
  PiThreadState,
  PiWake,
} from "../adapter.ts";
import { protocolError } from "./protocol.ts";
import type { State } from "./base.ts";

export const makeEmitters = (deps: State) => {
  const {
    input,
    idAllocator,
    now,
    events,
    scope,
    modelContextWindows,
  } = deps;
  const m = deps.mutable;
  const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(events, event).pipe(Effect.asVoid);

  const updateProviderSession =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      status: OrchestrationV2ProviderSession["status"],
      lastError: string | null = m.sessionEntity.lastError,
    ) {
      const updatedAt = yield* DateTime.now;
      m.sessionEntity = { ...m.sessionEntity, status, lastError, updatedAt };
      yield* emit({
        type: "provider_session.updated",
        driver: PI_PROVIDER,
        providerSession: m.sessionEntity,
      });
    });

  const updateProviderThread =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      state: PiThreadState,
      patch: Partial<OrchestrationV2ProviderThread>,
      retainedNativeTurnIds?: ReadonlyArray<string>,
    ) {
      const updatedAt = yield* DateTime.now;
      state.providerThread = { ...state.providerThread, ...patch, updatedAt };
      yield* emit({
        type: "provider_thread.updated",
        driver: PI_PROVIDER,
        providerThread: state.providerThread,
        ...(retainedNativeTurnIds === undefined ? {} : { retainedNativeTurnIds }),
      });
    });

  const itemOrdinal = (turn: ActivePiTurn, nativeItemId: string): number => {
    const existing = turn.itemOrdinals.get(nativeItemId);
    if (existing !== undefined) return existing;
    const ordinal = turn.nextItemOrdinal++;
    turn.itemOrdinals.set(nativeItemId, ordinal);
    return ordinal;
  };

  const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
    const value = recordNumber(input, key);
    return value === undefined ? undefined : Math.max(0, Math.trunc(value));
  };

  const rememberModelContextWindow = (model: unknown): number | null => {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    const capacity = nonNegativeInteger(model, "contextWindow");
    if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
      modelContextWindows.set(`${provider}/${id}`, capacity);
      return capacity;
    }
    return null;
  };

  const baseItemFields = (
    turn: ActivePiTurn,
    nativeItemId: string,
    startedAt: DateTime.Utc,
    updatedAt: DateTime.Utc,
    parentNativeItemId?: string,
  ) => ({
    id: idAllocator.derive.turnItemFromProviderItem({
      driver: PI_PROVIDER,
      nativeItemId,
    }),
    threadId: turn.turnInput.threadId,
    runId: turn.turnInput.runId,
    nodeId: idAllocator.derive.nodeFromProviderItem({
      driver: PI_PROVIDER,
      nativeItemId,
    }),
    providerThreadId: turn.turnInput.providerThread.id,
    providerTurnId: turn.providerTurn.id,
    nativeItemRef: providerRef(nativeItemId),
    parentItemId:
      parentNativeItemId === undefined
        ? null
        : idAllocator.derive.turnItemFromProviderItem({
            driver: PI_PROVIDER,
            nativeItemId: parentNativeItemId,
          }),
    ordinal: itemOrdinal(turn, nativeItemId),
    startedAt,
    updatedAt,
  });

  const emitItemNode = (
    turn: ActivePiTurn,
    nativeItemId: string,
    kind: OrchestrationV2ExecutionNode["kind"],
    status: OrchestrationV2ExecutionNode["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
    parentNativeItemId?: string,
  ) =>
    emit({
      type: "node.updated",
      driver: PI_PROVIDER,
      node: {
        id: idAllocator.derive.nodeFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        parentNodeId:
          parentNativeItemId === undefined
            ? turn.turnInput.rootNodeId
            : idAllocator.derive.nodeFromProviderItem({
                driver: PI_PROVIDER,
                nativeItemId: parentNativeItemId,
              }),
        rootNodeId: turn.turnInput.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    });

  const emitProviderRetry = Effect.fnUntraced(function* (
    turn: ActivePiTurn,
    providerRetry: PiProviderRetryState,
    status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
    updatedAt: DateTime.Utc,
  ) {
    yield* emit({
      type: "turn_item.updated",
      driver: PI_PROVIDER,
      turnItem: makeProviderRetryTurnItem({
        driver: PI_PROVIDER,
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: turn.turnInput.rootNodeId,
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        itemOrdinal: providerRetry.itemOrdinal,
        failure: providerRetry.failure,
        retry: providerRetry.retry,
        status,
        startedAt: providerRetry.startedAt,
        updatedAt,
      }),
    });
  });

  const compactionNativeItemId = (turn: ActivePiTurn): string =>
    `compaction:${turn.providerTurn.id}:${turn.nextItemOrdinal}`;

  const emitCompaction = Effect.fnUntraced(function* (
    turn: ActivePiTurn,
    compaction: PiCompactionState,
    status: PiCompactionStatus,
    details: {
      readonly summary?: string;
      readonly beforeTokenCount?: number;
      readonly afterTokenCount?: number;
    } = {},
  ) {
    const emittedAt = yield* DateTime.now;
    const completedAt = status === "running" ? null : emittedAt;
    yield* emitItemNode(
      turn,
      compaction.nativeItemId,
      "system",
      status,
      compaction.startedAt,
      completedAt,
    );
    yield* emit({
      type: "turn_item.updated",
      driver: PI_PROVIDER,
      turnItem: {
        ...baseItemFields(turn, compaction.nativeItemId, compaction.startedAt, emittedAt),
        status,
        title: compactionTitle(status),
        completedAt,
        type: "compaction",
        driver: PI_PROVIDER,
        ...details,
      },
    });
  });

  const emitStreamItem =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      turn: ActivePiTurn,
      item: PiStreamItemState,
      streaming: boolean,
    ) {
      const emittedAt = yield* DateTime.now;
      const base = baseItemFields(turn, item.nativeItemId, item.startedAt, emittedAt);
      yield* emitItemNode(
        turn,
        item.nativeItemId,
        item.kind,
        streaming ? "running" : "completed",
        item.startedAt,
        streaming ? null : emittedAt,
      );
      if (item.kind === "assistant_message") {
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: PI_PROVIDER,
          nativeItemId: item.nativeItemId,
        });
        yield* emit({
          type: "turn_item.updated",
          driver: PI_PROVIDER,
          turnItem: {
            ...base,
            status: streaming ? "running" : "completed",
            title: null,
            completedAt: streaming ? null : emittedAt,
            type: "assistant_message",
            messageId,
            text: item.text,
            streaming,
          },
        });
        yield* emit({
          type: "message.updated",
          driver: PI_PROVIDER,
          message: {
            id: messageId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: idAllocator.derive.nodeFromProviderItem({
              driver: PI_PROVIDER,
              nativeItemId: item.nativeItemId,
            }),
            role: "assistant",
            text: item.text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: item.startedAt,
            updatedAt: emittedAt,
          },
        });
        return;
      }
      yield* emit({
        type: "turn_item.updated",
        driver: PI_PROVIDER,
        turnItem: {
          ...base,
          status: streaming ? "running" : "completed",
          title: null,
          completedAt: streaming ? null : emittedAt,
          type: "reasoning",
          text: item.text,
          streaming,
        },
      });
    });

  const scheduleStreamFlush =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (turn: ActivePiTurn, item: PiStreamItemState) {
      if (item.flushScheduled || item.completed) return;
      item.flushScheduled = true;
      yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            item.flushScheduled = false;
            return item.completed ? Effect.void : emitStreamItem(turn, item, true);
          }),
        ),
        Effect.forkIn(scope),
      );
    });

  const streamItemFor = Effect.fnUntraced(function* (
    turn: ActivePiTurn,
    kind: PiStreamItemState["kind"],
    contentIndex: number,
  ) {
    const nativeItemId = `${turn.providerTurn.id}:m${turn.messageOrdinal}:c${contentIndex}`;
    const existing = turn.streamItems.get(nativeItemId);
    if (existing !== undefined) return existing;
    const startedAt = yield* DateTime.now;
    const item: PiStreamItemState = {
      nativeItemId,
      kind,
      text: "",
      completed: false,
      flushScheduled: false,
      startedAt,
    };
    turn.streamItems.set(nativeItemId, item);
    itemOrdinal(turn, nativeItemId);
    return item;
  });

  const completeStreamItem = (turn: ActivePiTurn, item: PiStreamItemState, text?: string) =>
    Effect.suspend(() => {
      if (item.completed) return Effect.void;
      item.completed = true;
      if (text !== undefined && text.length > 0) item.text = text;
      return item.text.length === 0 ? Effect.void : emitStreamItem(turn, item, false);
    });

  const completeOpenStreamItems = (turn: ActivePiTurn) =>
    Effect.forEach(
      Array.from(turn.streamItems.values()).filter((item) => !item.completed),
      (item) => completeStreamItem(turn, item),
      { discard: true },
    );

  const emitSystemNotice = Effect.fnUntraced(function* (
    turn: ActivePiTurn,
    nativeItemId: string,
    message: string,
  ) {
    const emittedAt = yield* DateTime.now;
    yield* emitItemNode(turn, nativeItemId, "system", "completed", emittedAt, emittedAt);
    yield* emit({
      type: "turn_item.updated",
      driver: PI_PROVIDER,
      turnItem: {
        ...baseItemFields(turn, nativeItemId, emittedAt, emittedAt),
        status: "completed",
        completedAt: emittedAt,
        title: message,
        type: "system_notice",
        message,
      },
    });
  });

  return { emit, updateProviderSession, updateProviderThread, itemOrdinal, nonNegativeInteger, rememberModelContextWindow, baseItemFields, emitItemNode, emitProviderRetry, compactionNativeItemId, emitCompaction, emitStreamItem, scheduleStreamFlush, streamItemFor, completeStreamItem, completeOpenStreamItems, emitSystemNotice };
};

export type Emitters = ReturnType<typeof makeEmitters>;
