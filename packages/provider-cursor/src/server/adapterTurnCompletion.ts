import type { RunResult } from "@cursor/sdk";
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeCursorAdapterProjection } from "./cursorAdapterProjection.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { type ProviderSessionId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
export { cursorSdkModelSelection } from "./sdkModel.ts";

import { CURSOR_RESUME_NO_PROGRESS_MESSAGE, type ActiveCursorTurn } from "./adapterSupport.ts";

export * from "./adapterSupport.ts";

type CursorProjection = ReturnType<typeof makeCursorAdapterProjection>;

export interface CursorTurnCompletionDeps {
  readonly providerSessionId: ProviderSessionId;
  readonly activeTurn: Ref.Ref<ActiveCursorTurn | null>;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
  readonly resolveItemOrdinal: (
    context: ActiveCursorTurn,
    nativeItemId: string,
  ) => Effect.Effect<number>;
  readonly projection: Pick<
    CursorProjection,
    "emitToolArtifacts" | "emitSubagent" | "completeReasoning" | "completeAssistant"
  >;
}

/** Turn completion: the terminal turn/thread events every exit path emits. */
export const makeCursorTurnCompletion = (deps: CursorTurnCompletionDeps) => {
  const {
    providerSessionId,
    activeTurn,
    emitProviderEvent,
    resolveItemOrdinal,
    projection: { emitToolArtifacts, emitSubagent, completeReasoning, completeAssistant },
  } = deps;
  const providerTurnPayload = (input: {
    readonly context: ActiveCursorTurn;
    readonly status: OrchestrationV2ProviderTurn["status"];
    readonly completedAt: DateTime.Utc | null;
  }): OrchestrationV2ProviderTurn => ({
    id: input.context.providerTurnId,
    providerThreadId: input.context.input.providerThread.id,
    nodeId: input.context.input.rootNodeId,
    runAttemptId: input.context.input.attemptId,
    nativeTurnRef: {
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeId: input.context.run.runId,
      strength: "strong",
    },
    ordinal: input.context.input.providerTurnOrdinal,
    status: input.status,
    startedAt: input.context.startedAt,
    completedAt: input.completedAt,
  });

  const finalizeTurn = Effect.fnUntraced(function* (input: {
    readonly context: ActiveCursorTurn;
    readonly status: Extract<
      OrchestrationV2ProviderTurn["status"],
      "completed" | "interrupted" | "failed" | "cancelled"
    >;
    readonly failure?: OrchestrationV2ProviderFailure;
    readonly threadDisposition?: "reusable" | "broken";
  }) {
    if (input.context.finalized) {
      return;
    }
    input.context.finalized = true;
    const completedAt = yield* DateTime.now;
    for (const tool of input.context.tools.values()) {
      yield* emitToolArtifacts({
        active: tool,
        completed: true,
        // No completion event means the tool outcome is unknown.
        unfinishedStatus: input.status === "completed" ? "interrupted" : input.status,
      });
    }
    input.context.tools.clear();
    for (const subagent of input.context.subagents.values()) {
      if (!isOrchestrationV2WorkActive(subagent.task.status)) continue;
      yield* emitSubagent({
        context: input.context,
        callId: subagent.callId,
        toolCall: subagent.toolCall,
        completed: true,
        status: input.status === "completed" ? "idle" : input.status,
      });
    }
    yield* completeReasoning(input.context);
    yield* completeAssistant(input.context);
    yield* emitProviderEvent({
      type: "provider_turn.updated",
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      providerTurn: providerTurnPayload({
        context: input.context,
        status: input.status,
        completedAt,
      }),
    });
    yield* emitProviderEvent({
      type: "provider_thread.updated",
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      providerThread: {
        ...input.context.input.providerThread,
        providerSessionId: providerSessionId,
        status: "active",
        firstRunOrdinal:
          input.context.input.providerThread.firstRunOrdinal ?? input.context.input.runOrdinal,
        lastRunOrdinal: input.context.input.runOrdinal,
        updatedAt: completedAt,
      },
    });
    const threadDisposition = input.threadDisposition ?? "reusable";
    yield* emitProviderEvent(
      input.status === "failed"
        ? {
            type: "turn.terminal",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            runOrdinal: input.context.input.runOrdinal,
            failureItemOrdinal: yield* resolveItemOrdinal(
              input.context,
              `terminal-failure:${input.context.providerTurnId}`,
            ),
            status: input.status,
            failure: input.failure ?? makeProviderFailure({ class: "provider_error" }),
            threadDisposition,
          }
        : {
            type: "turn.terminal",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            runOrdinal: input.context.input.runOrdinal,
            status: input.status,
            failure: null,
            threadDisposition,
          },
    );
    yield* Ref.update(activeTurn, (current) =>
      current?.providerTurnId === input.context.providerTurnId ? null : current,
    );
    yield* Deferred.succeed(input.context.completed, undefined);
  });

  const isResumeFailureAfterTurnEnded = (context: ActiveCursorTurn, result: RunResult) =>
    context.turnEnded &&
    result.status === "error" &&
    result.error?.message === CURSOR_RESUME_NO_PROGRESS_MESSAGE;

  const terminalStatus = (
    context: ActiveCursorTurn,
    result: RunResult,
  ): Extract<
    OrchestrationV2ProviderTurn["status"],
    "completed" | "interrupted" | "failed" | "cancelled"
  > => {
    if (context.interrupted) {
      return "interrupted";
    }
    switch (result.status) {
      case "finished":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "error":
        return isResumeFailureAfterTurnEnded(context, result) ? "completed" : "failed";
    }
  };

  return {
    finalizeTurn,
    providerTurnPayload,
    isResumeFailureAfterTurnEnded,
    terminalStatus,
  };
};
