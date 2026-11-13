/**
 * OpenCode turn finalization and prompt admission reconciliation.
 */
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
import * as Effect from "effect/Effect";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  reconcileOpenCodePromptAdmissionStatus,
} from "../admission.ts";
import {
  providerRef,
  unwrapData,
} from "../projection.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import type {
  ActiveOpenCodeTurn,
  OpenCodeThreadState,
} from "../types.ts";
import type {
  TerminalTurnStatus,
} from "../usage.ts";
import type { Items } from "./items.ts";
import type { Requests } from "./requests.ts";
import type { State } from "./base.ts";

export const makeTurns = (deps: State & Items & Requests) => {
  const {
    client,
    scope,
    now,
    threads,
    pendingRequests,
    emitProviderEvent,
    sdkCall,
  } = deps;
  const m = deps.mutable;
  const finalizeTurn = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    status: TerminalTurnStatus,
    terminal?: {
      readonly failure?: OrchestrationV2ProviderFailure;
      readonly threadDisposition?: "reusable" | "broken";
    },
  ) {
    if (turn.finalized) return;
    if (m.nativeStreamFailure !== null) {
      status = "failed";
      terminal = { failure: m.nativeStreamFailure, threadDisposition: "broken" };
    }
    turn.finalized = true;
    const completedAt = yield* DateTime.now;
    for (const part of turn.parts.values()) {
      if (part.type === "text" || part.type === "reasoning") {
        yield* deps.emitTextPart(state, turn, part, true);
      }
    }
    for (const pending of Array.from(pendingRequests.values())) {
      if (
        pending.turn.providerTurnId === turn.providerTurnId ||
        pending.nativeSessionId === state.nativeSessionId
      ) {
        yield* deps.resolveRuntimeRequest(pending.nativeRequestId, "cancelled");
      }
    }
    yield* deps.emitProviderTurn(state, turn, status, completedAt);
    const threadDisposition = terminal?.threadDisposition ?? "reusable";
    yield* deps.updateProviderThread(state, {
      status: turn.isRoot ? "active" : threadDisposition === "broken" ? "error" : "idle",
      nativeConversationHeadRef:
        turn.nativeUserMessageId === null
          ? state.providerThread.nativeConversationHeadRef
          : providerRef(turn.nativeUserMessageId, "weak"),
    });
    state.activeTurn = null;
    if (!turn.isRoot) {
      yield* emitProviderEvent({
        type: "node.updated",
        driver: OPENCODE_PROVIDER,
        node: {
          id: turn.rootNodeId,
          threadId: turn.threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: turn.rootNodeId,
          kind: "root_turn",
          status,
          countsForRun: false,
          providerThreadId: state.providerThread.id,
          providerTurnId: turn.providerTurnId,
          nativeItemRef: providerRef(state.nativeSessionId),
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: turn.startedAt,
          completedAt,
        },
      });
      return;
    }
    const anotherTurnIsActive = Array.from(threads.values()).some(
      (candidate) => candidate.activeTurn?.isRoot === true,
    );
    yield* deps.updateProviderSession(
      anotherTurnIsActive ? "running" : status === "failed" ? "error" : "ready",
      status === "failed" ? m.sessionEntity.lastError : null,
    );
    yield* emitProviderEvent(
      status === "failed"
        ? {
            type: "turn.terminal",
            driver: OPENCODE_PROVIDER,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.providerTurnId,
            runOrdinal: turn.runOrdinal,
            failureItemOrdinal: deps.itemOrdinal(turn, `terminal-failure:${turn.providerTurnId}`),
            status,
            failure:
              terminal?.failure ??
              makeProviderFailure({
                message: m.sessionEntity.lastError ?? undefined,
                class: "provider_error",
              }),
            threadDisposition,
          }
        : {
            type: "turn.terminal",
            driver: OPENCODE_PROVIDER,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.providerTurnId,
            runOrdinal: turn.runOrdinal,
            status,
            failure: null,
            threadDisposition,
          },
    );
  });

  const promptAdmissionIsCurrent = (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    generation: number,
  ) =>
    state.activeTurn === turn &&
    !turn.finalized &&
    !turn.interrupted &&
    turn.admissionPending &&
    turn.admissionGeneration === generation;

  const runPromptAdmissionReconciliation = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
    generation: number,
  ) {
    while (promptAdmissionIsCurrent(state, turn, generation)) {
      const status = yield* reconcileOpenCodePromptAdmissionStatus(
        turn,
        generation,
        sdkCall("session.status", { sessionID: state.nativeSessionId, generation }, () =>
          client.session.status(),
        ).pipe(
          Effect.match({
            onFailure: () => "unknown" as const,
            onSuccess: (response) => {
              const statuses = unwrapData("session.status", response);
              const sessionStatus = statuses[state.nativeSessionId];
              return sessionStatus === undefined || sessionStatus.type === "idle"
                ? ("idle" as const)
                : ("busy" as const);
            },
          }),
        ),
      );
      if (
        state.activeTurn !== turn ||
        status === "stale" ||
        turn.finalized ||
        turn.interrupted ||
        turn.admissionGeneration !== generation
      ) {
        return;
      }
      if (status === "idle") {
        yield* finalizeTurn(state, turn, "completed");
        return;
      }
      if (status === "busy") return;
      yield* Effect.sleep("250 millis");
    }
  });

  const reconcilePromptAdmission = Effect.fnUntraced(function* (
    state: OpenCodeThreadState,
    turn: ActiveOpenCodeTurn,
  ) {
    const generation = turn.admissionGeneration;
    if (
      !promptAdmissionIsCurrent(state, turn, generation) ||
      turn.admissionReconciliationGeneration === generation
    ) {
      return;
    }
    turn.admissionReconciliationGeneration = generation;
    yield* runPromptAdmissionReconciliation(state, turn, generation).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (turn.admissionReconciliationGeneration === generation) {
            turn.admissionReconciliationGeneration = null;
          }
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  return { finalizeTurn, promptAdmissionIsCurrent, runPromptAdmissionReconciliation, reconcilePromptAdmission };
};

export type Turns = ReturnType<typeof makeTurns>;
