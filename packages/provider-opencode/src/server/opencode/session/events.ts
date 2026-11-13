/**
 * OpenCode event translation: messages, parts, deltas and compaction into turn items.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  advanceOpenCodePromptAdmission,
} from "../admission.ts";
import {
  isMessageAbortedError,
  openCodeErrorMessage,
  providerRef,
  terminalStatusForError,
} from "../projection.ts";
import {
  dateTimeFromEpoch,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import type {
  ActiveOpenCodeTurn,
  OpenCodeThreadState,
} from "../types.ts";
import type {
  OpenCodeStepUsage,
} from "../usage.ts";
import {
  accumulateOpenCodeStepUsage,
  makeOpenCodeTurnTokenUsageAccumulator,
} from "../usage.ts";
import type { Items } from "./items.ts";
import type { Subagents } from "./subagents.ts";
import type { ToolParts } from "./toolParts.ts";
import type { Requests } from "./requests.ts";
import type { Turns } from "./turns.ts";
import type { State } from "./base.ts";

export const makeEvents = (deps: State & Items & Subagents & ToolParts & Requests & Turns) => {
  const {
    idAllocator,
    now,
    threads,
    commandReceipts,
    relatedSessionOwners,
    busySessionIds,
    rememberSettledRequest,
    emitProviderEvent,
    logProtocolEvent,
  } = deps;
  const m = deps.mutable;
  const createChildTurn = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    message: Extract<OpenCodeMessage, { role: "user" }>,
  ) {
    if (state.appThread === null || state.parentSubagent === null) return null;
    const now = yield* DateTime.now;
    const startedAt = dateTimeFromEpoch(message.time.created, now);
    const rootNodeId = idAllocator.derive.nodeFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: `${state.nativeSessionId}:root:${message.id}`,
    });
    const providerTurnId = idAllocator.derive.providerTurn({
      driver: OPENCODE_PROVIDER,
      nativeTurnId: message.id,
    });
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: providerTurnId,
      providerThreadId: state.providerThread.id,
      nodeId: rootNodeId,
      runAttemptId: null,
      nativeTurnRef: providerRef(message.id, "weak"),
      ordinal: state.nextChildTurnOrdinal++,
      status: "running",
      startedAt,
      completedAt: null,
    };
    const turn: ActiveOpenCodeTurn = {
      isRoot: false,
      threadId: state.appThread.id,
      runId: null,
      rootNodeId,
      appThread: state.appThread,
      modelSelection: state.appThread.modelSelection,
      runtimePolicy: state.parentSubagent.parentTurn.runtimePolicy,
      providerTurnId,
      providerThreadId: providerTurn.providerThreadId,
      runOrdinal: state.parentSubagent.parentTurn.runOrdinal,
      startedAt,
      itemOrdinals: new Map(),
      usage: makeOpenCodeTurnTokenUsageAccumulator(),
      parts: new Map(),
      partIdsByMessage: new Map(),
      toolNamesByCallId: new Map(),
      providerTurn,
      nextItemOrdinal: 1,
      nativeUserMessageId: message.id,
      admissionMessageId: null,
      interrupted: false,
      finalized: false,
      planId: null,
      admissionGeneration: 0,
      admissionReconciliationGeneration: null,
      admissionPending: false,
      admissionAccepted: true,
      admissionMessageObserved: true,
      idleDuringAdmission: false,
      admissionSettled: Deferred.makeUnsafe<void>(),
      admissionAbortController: null,
    };
    state.activeTurn = turn;
    state.providerTurns.set(String(providerTurnId), providerTurn);
    yield* emitProviderEvent({
      type: "node.updated",
      driver: OPENCODE_PROVIDER,
      node: {
        id: rootNodeId,
        threadId: turn.threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: state.providerThread.id,
        providerTurnId,
        nativeItemRef: providerRef(message.id, "weak"),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt: null,
      },
    });
    yield* deps.emitProviderTurn(state, turn, "running", null);
    return turn;
  });

  const projectChildUserPart = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    part: Extract<OpenCodePart, { type: "text" }>,
  ) {
    const now = yield* DateTime.now;
    const messageId = idAllocator.derive.messageFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.messageID,
    });
    const turnItemId = idAllocator.derive.turnItemFromProviderItem({
      driver: OPENCODE_PROVIDER,
      nativeItemId: part.messageID,
    });
    const projected: OrchestrationV2ConversationMessage = {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId: turn.threadId,
      runId: null,
      nodeId: turn.rootNodeId,
      role: "user",
      text: part.text,
      attachments: [],
      streaming: false,
      createdAt: turn.startedAt,
      updatedAt: now,
    };
    yield* emitProviderEvent({
      type: "message.updated",
      driver: OPENCODE_PROVIDER,
      message: projected,
    });
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: {
        createdBy: "agent",
        creationSource: "provider",
        id: turnItemId,
        threadId: turn.threadId,
        runId: null,
        nodeId: turn.rootNodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: providerRef(part.messageID),
        parentItemId: null,
        ordinal: deps.itemOrdinal(turn, part.messageID),
        status: "completed",
        title: null,
        startedAt: projected.createdAt,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text: part.text,
        attachments: [],
      },
    });
  });

  const emitCompactionItem = Effect.fn("OpenCodeAdapterV2.emitCompactionItem")(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
  ) {
    const nativeItemId = `${turn.providerTurnId}:compaction`;
    if (turn.itemOrdinals.has(nativeItemId)) return;
    const now = yield* DateTime.now;
    yield* emitProviderEvent({
      type: "turn_item.updated",
      driver: OPENCODE_PROVIDER,
      turnItem: {
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: OPENCODE_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.threadId,
        runId: turn.runId,
        nodeId: turn.rootNodeId,
        providerThreadId: state.providerThread.id,
        providerTurnId: turn.providerTurnId,
        nativeItemRef: providerRef(nativeItemId, "weak"),
        parentItemId: null,
        ordinal: deps.itemOrdinal(turn, nativeItemId),
        type: "compaction",
        driver: OPENCODE_PROVIDER,
        status: "completed",
        title: "Context compacted",
        startedAt: turn.startedAt,
        completedAt: now,
        updatedAt: now,
      },
    });
  });

  const handleMessageUpdated = Effect.fnUntraced(function* (
    event: Extract<OpenCodeEvent, { type: "message.updated" }>,
  ) {
    const state = threads.get(event.properties.sessionID);
    if (state === undefined) return;
    const message = event.properties.info;
    state.messageRoles.set(message.id, message.role);
    if (message.role === "assistant") {
      const usage = state.activeTurn?.usage;
      if (usage === undefined) return;
      const prior = usage.assistantOwnershipByMessageId.get(message.id);
      const ownership =
        prior !== undefined && prior !== "unknown"
          ? prior
          : !message.parentID
            ? "unknown"
            : usage.promptMessageIds.has(message.parentID)
              ? "owned"
              : "other";
      usage.assistantOwnershipByMessageId.set(message.id, ownership);
      if (ownership !== "unknown") {
        if (ownership === "owned") {
          for (const step of usage.unresolvedStepsByMessageId.get(message.id)?.values() ??
            []) {
            accumulateOpenCodeStepUsage(usage, step);
          }
        }
        usage.unresolvedStepsByMessageId.delete(message.id);
      }
      return;
    }
    const commandReceipt = commandReceipts.get(message.id);
    if (commandReceipt) yield* Deferred.succeed(commandReceipt, undefined);
    const isNewUserMessage = !state.userMessageIds.includes(message.id);
    if (isNewUserMessage) state.userMessageIds.push(message.id);
    let turn = state.activeTurn;
    if (turn === null && state.parentSubagent !== null && isNewUserMessage) {
      turn = yield* createChildTurn(state, message);
    }
    const matchesAdmission =
      turn !== null &&
      (turn.admissionMessageId === null || turn.admissionMessageId === message.id);
    if (turn !== null && matchesAdmission) turn.usage.promptMessageIds.add(message.id);
    if (turn !== null && matchesAdmission && turn.nativeUserMessageId === null) {
      turn.nativeUserMessageId = message.id;
      yield* deps.emitProviderTurn(state, turn, "running", null);
    }
    if (turn !== null && matchesAdmission && turn.admissionPending) {
      if (advanceOpenCodePromptAdmission(turn, "user-message") === "reconcile-idle") {
        yield* deps.reconcilePromptAdmission(state, turn);
      }
    }
  });

  const handlePartUpdated = Effect.fnUntraced(function* (
    event: Extract<OpenCodeEvent, { type: "message.part.updated" }>,
  ) {
    const part = event.properties.part;
    const state = threads.get(part.sessionID);
    const turn = state?.activeTurn;
    if (state === undefined || turn === null || turn === undefined || turn.finalized) return;
    if (part.type === "text" && state.messageRoles.get(part.messageID) === "user") {
      if (!turn.isRoot) yield* projectChildUserPart(state, turn, part);
      return;
    }
    if (part.type === "step-finish") {
      const usage = turn.usage;
      const ownership = usage.assistantOwnershipByMessageId.get(part.messageID);
      if (ownership === "owned") accumulateOpenCodeStepUsage(usage, part);
      else if (
        ownership === "unknown" ||
        (ownership === undefined && !state.messageRoles.has(part.messageID))
      ) {
        const steps =
          usage.unresolvedStepsByMessageId.get(part.messageID) ??
          new Map<string, OpenCodeStepUsage>();
        steps.set(part.id, { id: part.id, tokens: part.tokens });
        usage.unresolvedStepsByMessageId.set(part.messageID, steps);
      }
      return;
    }
    if (part.type === "tool") {
      turn.toolNamesByCallId.set(part.callID, part.tool);
    } else {
      turn.parts.set(part.id, part);
      const ids = turn.partIdsByMessage.get(part.messageID) ?? new Set<string>();
      ids.add(part.id);
      turn.partIdsByMessage.set(part.messageID, ids);
    }
    switch (part.type) {
      case "text":
      case "reasoning":
        yield* deps.emitTextPart(state, turn, part);
        return;
      case "tool":
        yield* deps.emitToolPart(state, turn, part);
        return;
      default:
        return;
    }
  });

  const handlePartDelta = Effect.fnUntraced(function* (
    event: Extract<OpenCodeEvent, { type: "message.part.delta" }>,
  ) {
    if (event.properties.field !== "text") return;
    const state = threads.get(event.properties.sessionID);
    const turn = state?.activeTurn;
    const current = turn?.parts.get(event.properties.partID);
    if (
      state === undefined ||
      turn === null ||
      turn === undefined ||
      current === undefined ||
      (current.type !== "text" && current.type !== "reasoning")
    ) {
      return;
    }
    const updated = { ...current, text: current.text + event.properties.delta };
    turn.parts.set(updated.id, updated);
    yield* deps.emitTextPart(state, turn, updated);
  });

  const handleAssistantCompleted = Effect.fnUntraced(function* (
    event: Extract<OpenCodeEvent, { type: "message.updated" }>,
  ) {
    const message = event.properties.info;
    if (message.role !== "assistant" || message.time.completed === undefined) return;
    const state = threads.get(message.sessionID);
    const turn = state?.activeTurn;
    if (state === undefined || turn === null || turn === undefined) return;
    // Versions may ignore supplied message IDs; completed assistant output admits settlement on idle.
    advanceOpenCodePromptAdmission(turn, "assistant-completed");
    for (const partId of turn.partIdsByMessage.get(message.id) ?? []) {
      const part = turn.parts.get(partId);
      if (part?.type === "text" || part?.type === "reasoning") {
        yield* deps.emitTextPart(state, turn, part, true);
      }
    }
  });

  const handleEvent = Effect.fnUntraced(function* (event: OpenCodeEvent) {
    yield* logProtocolEvent({
      direction: "incoming",
      messageKind: "notification",
      method: event.type,
      payload: event,
    });
    switch (event.type) {
      case "server.connected":
        if (m.hasConnected) {
          for (const state of threads.values()) {
            if (state.activeTurn !== null) state.activeTurn.usage.complete = false;
          }
        }
        m.hasConnected = true;
        return;
      case "message.updated":
        yield* handleMessageUpdated(event);
        yield* handleAssistantCompleted(event);
        return;
      case "session.compacted": {
        const state = threads.get(event.properties.sessionID);
        if (state?.activeTurn !== undefined && state.activeTurn !== null) {
          yield* emitCompactionItem(state, state.activeTurn);
        }
        return;
      }
      case "message.part.updated":
        yield* handlePartUpdated(event);
        return;
      case "message.part.delta":
        yield* handlePartDelta(event);
        return;
      case "todo.updated": {
        const state = threads.get(event.properties.sessionID);
        if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
          yield* deps.emitTodo(state, state.activeTurn, event.properties.todos);
        }
        return;
      }
      case "permission.asked":
        yield* deps.routeRuntimeRequest(event.properties.id, event.properties.sessionID, {
          type: "permission",
          value: event.properties,
        });
        return;
      case "question.asked":
        yield* deps.routeRuntimeRequest(event.properties.id, event.properties.sessionID, {
          type: "question",
          value: event.properties,
        });
        return;
      case "permission.replied":
      case "question.replied":
        rememberSettledRequest(event.properties.requestID);
        yield* deps.resolveRuntimeRequest(event.properties.requestID, "resolved");
        return;
      case "question.rejected":
        rememberSettledRequest(event.properties.requestID);
        yield* deps.resolveRuntimeRequest(event.properties.requestID, "cancelled");
        return;
      case "session.created":
      case "session.updated": {
        const info = event.properties.info;
        if (info.parentID !== undefined && !threads.has(info.id)) {
          const owner = threads.get(info.parentID) ?? relatedSessionOwners.get(info.parentID);
          if (owner !== undefined) {
            relatedSessionOwners.set(info.id, owner);
          }
        }
        return;
      }
      case "session.deleted":
        relatedSessionOwners.delete(event.properties.info.id);
        busySessionIds.delete(event.properties.info.id);
        return;
      case "session.status": {
        const sessionId = event.properties.sessionID;
        switch (event.properties.status.type) {
          case "busy":
          case "retry":
            if (threads.has(sessionId) || relatedSessionOwners.has(sessionId)) {
              busySessionIds.add(sessionId);
            }
            break;
          case "idle":
            busySessionIds.delete(sessionId);
            break;
        }
        const state = threads.get(sessionId);
        if (state === undefined) return;
        if (event.properties.status.type === "busy") {
          yield* deps.updateProviderThread(state, { status: "active" });
          return;
        }
        if (event.properties.status.type === "idle" && state.activeTurn !== null) {
          if (state.activeTurn.admissionPending) {
            advanceOpenCodePromptAdmission(state.activeTurn, "idle");
            return;
          }
          yield* deps.finalizeTurn(
            state,
            state.activeTurn,
            state.activeTurn.interrupted ? "interrupted" : "completed",
          );
        }
        return;
      }
      case "session.idle": {
        busySessionIds.delete(event.properties.sessionID);
        const state = threads.get(event.properties.sessionID);
        if (state?.activeTurn !== null && state?.activeTurn !== undefined) {
          if (state.activeTurn.admissionPending) {
            advanceOpenCodePromptAdmission(state.activeTurn, "idle");
            return;
          }
          yield* deps.finalizeTurn(
            state,
            state.activeTurn,
            state.activeTurn.interrupted ? "interrupted" : "completed",
          );
        }
        return;
      }
      case "session.error": {
        const states =
          event.properties.sessionID === undefined
            ? Array.from(threads.values()).filter((state) => state.activeTurn !== null)
            : [threads.get(event.properties.sessionID)].filter(
                (state): state is OpenCodeThreadState => state !== undefined,
              );
        const error = event.properties.error;
        const usageLimit = error?.name === "APIError" && error.data.statusCode === 429;
        const failure = makeProviderFailure({
          message: openCodeErrorMessage(event),
          code: error?.name ?? null,
          class: usageLimit ? "usage_limit" : "provider_error",
        });
        if (
          !isMessageAbortedError(event) &&
          (event.properties.sessionID === undefined ||
            states.some((state) => state.parentSubagent === null))
        ) {
          yield* deps.updateProviderSession("error", failure.message);
        }
        for (const state of states) {
          if (state.activeTurn !== null) {
            yield* deps.finalizeTurn(
              state,
              state.activeTurn,
              terminalStatusForError(event, state.activeTurn),
              {
                failure,
                threadDisposition:
                  event.properties.sessionID === undefined ? "broken" : "reusable",
              },
            );
          }
        }
        return;
      }
      default:
        return;
    }
  });

  return { createChildTurn, projectChildUserPart, emitCompactionItem, handleMessageUpdated, handlePartUpdated, handlePartDelta, handleAssistantCompleted, handleEvent };
};

export type Events = ReturnType<typeof makeEvents>;
