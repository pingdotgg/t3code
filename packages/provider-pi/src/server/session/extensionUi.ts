/**
 * Pi extension UI requests: approvals, questions and extension error notices.
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
import {
  piQuestion,
} from "./projection.ts";
import type { State } from "./base.ts";
import type { Emitters } from "./emitters.ts";

export const makeExtensionUi = (deps: State & Emitters) => {
  const {
    input,
    connection,
    idAllocator,
    now,
    events,
    scope,
    pendingPrompts,
    sessionApprovals,
  } = deps;
  const m = deps.mutable;
  const handleExtensionUiRequest = Effect.fnUntraced(function* (event: PiRpcRecord) {
    const method = recordString(event, "method");
    const nativeRequestId = recordString(event, "id");
    if (method === undefined) return;
    if (method === "notify") {
      const state = m.threadState;
      const turn = state?.activeTurn ?? null;
      const message = recordString(event, "message") ?? "";
      if (turn === null || message.length === 0) return;
      yield* deps.emitSystemNotice(
        turn,
        `notify:${turn.providerTurn.id}:${turn.nextItemOrdinal}`,
        message,
      );
      return;
    }
    if (
      method !== "select" &&
      method !== "confirm" &&
      method !== "input" &&
      method !== "editor"
    ) {
      yield* Effect.logDebug("Ignoring pi extension UI update.", { method });
      return;
    }
    if (nativeRequestId === undefined) return;
    const approvalTitle = recordString(event, "title") ?? "";
    const approvalKey = `${approvalTitle.length}:${approvalTitle}${recordString(event, "message") ?? ""}`;
    if (method === "confirm" && sessionApprovals.has(approvalKey)) {
      yield* connection.send({
        type: "extension_ui_response",
        id: nativeRequestId,
        confirmed: true,
      });
      return;
    }
    const state = m.threadState;
    const turn = state?.activeTurn ?? null;
    const createdAt = yield* DateTime.now;
    const timeout = recordNumber(event, "timeout");
    // Pi treats zero as no timeout and negative durations as immediate expiry.
    const expiresAt =
      timeout === undefined || timeout === 0
        ? null
        : DateTime.toEpochMillis(createdAt) + Math.max(0, timeout);
    const requestId = yield* idAllocator.allocate.runtimeRequest({
      driver: PI_PROVIDER,
      ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
      nativeRequestId,
    });
    const nodeId = idAllocator.derive.approvalNode({ requestId });
    const title = recordString(event, "title") ?? method;
    const threadId =
      turn?.turnInput.threadId ?? state?.providerThread.appThreadId ?? input.threadId;
    const providerThreadId = state?.providerThread.id ?? null;
    const providerTurnId = turn?.providerTurn.id ?? null;
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId,
      nativeRequestRef: providerRef(nativeRequestId),
      kind: method === "confirm" ? "command" : "user_input",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: input.providerSessionId },
      createdAt,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId,
      runId: turn?.turnInput.runId ?? null,
      parentNodeId: turn?.turnInput.rootNodeId ?? null,
      rootNodeId: turn?.turnInput.rootNodeId ?? nodeId,
      kind: method === "confirm" ? "approval_request" : "user_input_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId,
      providerTurnId,
      nativeItemRef: providerRef(nativeRequestId),
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: null,
    };
    const itemBase = {
      id: idAllocator.derive.approvalTurnItem({ requestId }),
      threadId,
      runId: turn?.turnInput.runId ?? null,
      nodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: providerRef(nativeRequestId),
      parentItemId: null,
      ordinal: turn === null ? 0 : deps.itemOrdinal(turn, nativeRequestId),
      status: "waiting" as const,
      title,
      startedAt: createdAt,
      completedAt: null,
      updatedAt: createdAt,
    };
    const turnItem: OrchestrationV2TurnItem =
      method === "confirm"
        ? {
            ...itemBase,
            type: "approval_request",
            requestId,
            requestKind: piApprovalRequestKind(title),
            prompt: recordString(event, "message") ?? title,
          }
        : {
            ...itemBase,
            type: "user_input_request",
            requestId,
            questions: [piQuestion(nativeRequestId, method, title, event)],
          };
    const pending: PendingPiPrompt = {
      nativeRequestId,
      method,
      questionId: nativeRequestId,
      approvalKey,
      expiresAt,
      expirationFiber: null,
      runtimeRequest,
      node,
      turnItem,
    };
    pendingPrompts.set(String(requestId), pending);
    yield* deps.emit({
      type: "runtime_request.updated",
      driver: PI_PROVIDER,
      threadId,
      runtimeRequest,
    });
    yield* deps.emit({ type: "node.updated", driver: PI_PROVIDER, node });
    yield* deps.emit({ type: "turn_item.updated", driver: PI_PROVIDER, turnItem });
    if (expiresAt !== null) {
      const now = yield* DateTime.now;
      pending.expirationFiber = yield* Effect.sleep(
        Duration.millis(Math.max(0, expiresAt - DateTime.toEpochMillis(now))),
      ).pipe(
        Effect.andThen(
          Queue.offer(connection.events, {
            type: "t3.ui_request_expired",
            requestId: String(requestId),
            pending,
          }),
        ),
        Effect.asVoid,
        Effect.forkIn(scope),
      );
    }
  });

  return { handleExtensionUiRequest };
};

export type ExtensionUi = ReturnType<typeof makeExtensionUi>;
