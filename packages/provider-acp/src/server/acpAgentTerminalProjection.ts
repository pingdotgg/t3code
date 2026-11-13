// ACP session behaviour extracted from server/adapter.ts (agentTerminalProjection).

import { applyAcpAgentTerminalUpdate, type AcpToolCallState } from "./runtimeModel.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { MAX_AGENT_TERMINAL_OUTPUT_CHARS, type ActiveAcpTurn } from "./acpTurnModel.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx10 } from "./acpSessionContext.ts";

export const createAcpAgentTerminalProjection = (ctx: AcpSessionCtx10) => {
  const projectAgentTerminalUpdate = Effect.fnUntraced(function* (
    notification: EffectAcpSchema.SessionNotification,
    context: ActiveAcpTurn | null,
  ) {
    const update = notification.update;
    if (
      update.sessionUpdate !== "terminal_update" &&
      update.sessionUpdate !== "terminal_output_chunk"
    ) {
      return false;
    }
    const terminalKey = ctx.sessionScopedId(notification.sessionId, update.terminalId);
    const next = applyAcpAgentTerminalUpdate(ctx.agentTerminalsById.get(terminalKey), update);
    ctx.agentTerminalsById.set(terminalKey, next);
    if (context === null || notification.sessionId !== context.nativeThreadId) return true;
    const status =
      next.exitStatus === undefined
        ? ("inProgress" as const)
        : next.exitStatus.exitCode === 0
          ? ("completed" as const)
          : ("failed" as const);
    const embeddedToolCallIds = ctx.toolCallIdsByAgentTerminalId.get(terminalKey);
    const projectedToolCallIds =
      embeddedToolCallIds === undefined || embeddedToolCallIds.size === 0
        ? [`acp-agent-terminal:${update.terminalId}`]
        : [...embeddedToolCallIds];
    const output = next.output.slice(-MAX_AGENT_TERMINAL_OUTPUT_CHARS);
    for (const toolCallId of projectedToolCallIds) {
      const existing = context.tools.get(toolCallId);
      const seeded: AcpToolCallState =
        existing ??
        ({
          toolCallId,
          kind: "execute",
          title: next.command ?? "Terminal",
          status,
          ...(next.command === undefined ? {} : { command: next.command }),
          data: { toolCallId },
        } satisfies AcpToolCallState);
      yield* ctx.emitTool(
        context,
        ctx.setToolOutputText(
          {
            ...seeded,
            status,
            ...(next.command === undefined ? {} : { command: next.command }),
          },
          output,
        ),
      );
    }
    return true;
  });
  const idleErrorFailure = (error: EffectAcpSchema.PromptResponse["error"]) =>
    ctx.flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: error?.code ?? -32603,
        errorMessage: error?.message ?? "Provider turn failed.",
        ...(error?.data === undefined ? {} : { data: error.data }),
      }),
    ) ??
    makeProviderFailure({
      message: error?.message,
      code: error == null ? null : String(error.code),
      class: "provider_error",
    });
  const settleIdleWork = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
  ): Effect.fn.Return<void> {
    if (
      !ctx.followsAgentWorkState ||
      context.finalized ||
      (!context.workAccepted && !context.interrupted) ||
      ctx.agentWork?.state !== "idle" ||
      ctx.agentRequests.size > 0
    )
      return;
    const work = ctx.agentWork;
    // Native close sends cancelled idle before acknowledging the user's Stop.
    if (work.stopReason === "cancelled" && ctx.pendingStopCloseTurn === context) {
      context.interrupted = true;
    }
    const failure = work.stopReason === "error" ? idleErrorFailure(work.error) : undefined;
    yield* ctx.late.finalizeTurn(
      context,
      failure !== undefined
        ? "failed"
        : work.stopReason === "cancelled"
          ? "cancelled"
          : "completed",
      failure,
    );
  });
  const awaitRequestTurn = Effect.fnUntraced(function* (generation: number) {
    if (!ctx.followsAgentWorkState) return true;
    while (true) {
      const waiting = yield* ctx.runRuntimeCallbackAtGeneration(
        generation,
        Effect.gen(function* () {
          if (yield* Ref.get(ctx.stoppedRunQuarantine)) return false;
          if ((yield* Ref.get(ctx.activeTurn)) !== null) return null;
          const sessionId = yield* Ref.get(ctx.activeSessionId);
          if (sessionId !== null) yield* ctx.late.offerContinuationRun(sessionId);
          return ctx.turnAttached;
        }),
      );
      if (Option.isNone(waiting)) return yield* Effect.never;
      if (waiting.value === false) return false;
      if (waiting.value === null) return true;
      if (!(yield* Deferred.await(waiting.value))) return false;
    }
  });
  const holdingAgentRequest =
    (generation: number) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() =>
        !ctx.followsAgentWorkState
          ? effect
          : Effect.acquireUseRelease(
              ctx.runRuntimeCallbackAtGeneration(
                generation,
                Effect.sync(() => {
                  const token = {};
                  ctx.agentRequests.add(token);
                  return token;
                }),
              ),
              (token) => (Option.isNone(token) ? Effect.never : effect),
              (token) =>
                ctx.runRuntimeCallbackAtGeneration(
                  generation,
                  Effect.gen(function* () {
                    if (Option.isSome(token)) ctx.agentRequests.delete(token.value);
                    const context = yield* Ref.get(ctx.activeTurn);
                    if (context !== null) yield* settleIdleWork(context);
                  }),
                ).pipe(Effect.asVoid),
            ),
      );
  return {
    projectAgentTerminalUpdate,
    idleErrorFailure,
    settleIdleWork,
    awaitRequestTurn,
    holdingAgentRequest,
  };
};
