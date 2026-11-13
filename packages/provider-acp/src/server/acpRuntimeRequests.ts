// ACP session behaviour extracted from server/adapter.ts (runtimeRequests).

import {
  type ProviderApprovalDecision,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { parsePermissionRequest } from "./runtimeModel.ts";
import { providerRequestKind } from "./acpToolCallProjection.ts";
import { type AcpAdapterV2UserInputRequest } from "./acpAdapterConfig.ts";
import { type ActiveAcpTurn, type PendingRuntimeRequest } from "./acpTurnModel.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { AcpSessionCtx12 } from "./acpSessionContext.ts";

export const createAcpRuntimeRequests = (ctx: AcpSessionCtx12) => {
  const activeContext = Effect.gen(function* () {
    const context = yield* Ref.get(ctx.activeTurn);
    if (context === null) {
      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP agent requested input without an active turn",
        cause: "No active ACP turn",
      });
    }
    return context;
  });
  const beginApprovalRequest = Effect.fnUntraced(function* (
    context: ActiveAcpTurn,
    params: EffectAcpSchema.RequestPermissionRequest,
    generation: number,
    transportRequestId: string,
  ) {
    yield* ctx.closeTextStreams(context);
    const parsed = parsePermissionRequest(params);
    const approvalOptions = ctx.flavor.approvalOptions?.(params);
    const nativeRequestId = params.toolCall.toolCallId;
    const requestId = yield* ctx.idAllocator.allocate.runtimeRequest({
      driver: ctx.driver,
      providerTurnId: context.providerTurnId,
      nativeRequestId,
    });
    const decision = yield* Deferred.make<ProviderApprovalDecision>();
    const nativeResponseAcknowledgement = yield* Deferred.make<
      void,
      EffectAcpErrors.AcpError
    >();
    yield* ctx.registerNativeResponseAcknowledgement(
      generation,
      transportRequestId,
      nativeResponseAcknowledgement,
    );
    const now = yield* DateTime.now;
    const nodeId = ctx.idAllocator.derive.approvalNode({ requestId });
    const requestKind = providerRequestKind(parsed.kind);
    const nativeItemRef = { driver: ctx.driver, nativeId: nativeRequestId, strength: "weak" as const };
    const ordinal = yield* ctx.resolveItemOrdinal(
      context,
      `${context.nativeTurnId}:approval:${nativeRequestId}`,
    );
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: context.providerTurnId,
      nativeRequestRef: nativeItemRef,
      kind: requestKind,
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId: ctx.input.providerSessionId,
      },
      createdAt: now,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: context.input.threadId,
      runId: context.input.runId,
      parentNodeId: context.input.rootNodeId,
      rootNodeId: context.input.rootNodeId,
      kind: "approval_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: context.input.providerThread.id,
      providerTurnId: context.providerTurnId,
      nativeItemRef,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: ctx.idAllocator.derive.approvalTurnItem({ requestId }),
      threadId: context.input.threadId,
      runId: context.input.runId,
      nodeId,
      providerThreadId: context.input.providerThread.id,
      providerTurnId: context.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal,
      status: "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "approval_request",
      requestId,
      requestKind,
      ...(parsed.detail === undefined ? {} : { prompt: parsed.detail }),
      ...(approvalOptions === undefined ? {} : { options: approvalOptions }),
    };
    yield* Ref.update(ctx.pendingRuntimeRequests, (current) => {
      const updated = new Map(current);
      updated.set(String(requestId), {
        type: "approval",
        generation,
        nativeResponseAcknowledgement,
        requestId,
        transportRequestId,
        decision,
        runtimeRequest,
        node,
        turnItem,
      });
      return updated;
    });
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node,
    });
    yield* ctx.emitProviderEvent({
      type: "runtime_request.updated",
      driver: ctx.driver,
      threadId: context.input.threadId,
      runtimeRequest,
    });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem,
    });
    return {
      context,
      decision,
      nativeResponseAcknowledgement,
      requestId,
      transportRequestId,
    } as const;
  });
  const beginUserInputRequest = Effect.fnUntraced(function* (
    request: AcpAdapterV2UserInputRequest,
    generation: number,
    transportRequestId: string,
  ) {
    const context = yield* activeContext;
    yield* ctx.closeTextStreams(context);
    const requestId = yield* ctx.idAllocator.allocate.runtimeRequest({
      driver: ctx.driver,
      providerTurnId: context.providerTurnId,
      nativeRequestId: request.nativeRequestId,
    });
    const answers = yield* Deferred.make<ProviderUserInputAnswers | null>();
    const nativeResponseAcknowledgement = yield* Deferred.make<
      void,
      EffectAcpErrors.AcpError
    >();
    yield* ctx.registerNativeResponseAcknowledgement(
      generation,
      transportRequestId,
      nativeResponseAcknowledgement,
    );
    const now = yield* DateTime.now;
    const nodeId = ctx.providerNodeId(request.nativeItemId);
    const turnItemId = ctx.providerTurnItemId(request.nativeItemId);
    const nativeItemRef = {
      driver: ctx.driver,
      nativeId: request.nativeItemId,
      strength: "weak" as const,
    };
    const ordinal = yield* ctx.resolveItemOrdinal(context, request.nativeItemId);
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: context.providerTurnId,
      nativeRequestRef: {
        driver: ctx.driver,
        nativeId: request.nativeRequestId,
        strength: "weak",
      },
      kind: "user_input",
      status: "pending",
      responseCapability: {
        type: "live",
        providerSessionId: ctx.input.providerSessionId,
      },
      createdAt: now,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: context.input.threadId,
      runId: context.input.runId,
      parentNodeId: context.input.rootNodeId,
      rootNodeId: context.input.rootNodeId,
      kind: "user_input_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: context.input.providerThread.id,
      providerTurnId: context.providerTurnId,
      nativeItemRef,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: turnItemId,
      threadId: context.input.threadId,
      runId: context.input.runId,
      nodeId,
      providerThreadId: context.input.providerThread.id,
      providerTurnId: context.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal,
      status: "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "user_input_request",
      requestId,
      questions: [...request.questions],
    };
    yield* Ref.update(ctx.pendingRuntimeRequests, (current) => {
      const updated = new Map(current);
      updated.set(String(requestId), {
        type: "user_input",
        generation,
        nativeResponseAcknowledgement,
        requestId,
        transportRequestId,
        answers,
        runtimeRequest,
        node,
        turnItem,
      });
      return updated;
    });
    yield* ctx.emitProviderEvent({
      type: "node.updated",
      driver: ctx.driver,
      node,
    });
    yield* ctx.emitProviderEvent({
      type: "runtime_request.updated",
      driver: ctx.driver,
      threadId: context.input.threadId,
      runtimeRequest,
    });
    yield* ctx.emitProviderEvent({
      type: "turn_item.updated",
      driver: ctx.driver,
      turnItem,
    });
    return {
      answers,
      context,
      nativeResponseAcknowledgement,
      requestId,
      transportRequestId,
    } as const;
  });
  const requestUserInputWithAdmission = Effect.fn(
    "AcpAdapterV2.requestUserInputWithAdmission",
  )(
    function* (
      generation: number,
      request: Effect.Effect<AcpAdapterV2UserInputRequest>,
      transportRequestId: string,
    ) {
      if (!(yield* ctx.awaitRequestTurn(generation))) {
        return { answers: null, acknowledgeNativeResponse: Effect.void };
      }
      return yield* ctx.runRuntimeCallbackAtGeneration(
        generation,
        request.pipe(
          Effect.flatMap((value) =>
            beginUserInputRequest(value, generation, transportRequestId),
          ),
        ),
      ).pipe(
        Effect.flatMap((pending) => {
          if (Option.isNone(pending)) return Effect.never;
          const { answers, requestId, transportRequestId } = pending.value;
          return Deferred.await(answers).pipe(
            Effect.flatMap((result) =>
              ctx.runRuntimeCallbackAtGeneration(generation, Effect.succeed(result)).pipe(
                Effect.flatMap((checked) =>
                  Option.isSome(checked)
                    ? Effect.succeed({
                        acknowledgeNativeResponse: ctx.acknowledgeNativeResponse(
                          generation,
                          transportRequestId,
                        ),
                        answers: checked.value,
                      })
                    : Effect.never,
                ),
              ),
            ),
            Effect.ensuring(
              ctx.runRuntimeCallbackAtGeneration(
                generation,
                Ref.update(ctx.pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(requestId));
                  return updated;
                }),
              ).pipe(Effect.asVoid),
            ),
          );
        }),
      );
    },
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to handle ACP user input request",
          cause,
        }),
    ),
  );
  ctx.late.cancelPendingRuntimeRequests = Effect.fnUntraced(function* () {
    const waiting = ctx.turnAttached;
    ctx.turnAttached = yield* Deferred.make<boolean>();
    yield* Deferred.succeed(waiting, false);
    const requests = yield* Ref.modify(ctx.pendingRuntimeRequests, (current) => [
      [...current.values()],
      new Map<string, PendingRuntimeRequest>(),
    ]);
    if (requests.length === 0) return;

    const now = yield* DateTime.now;
    yield* Effect.forEach(
      requests,
      (request) =>
        Effect.gen(function* () {
          const cancelled = yield* request.type === "approval"
            ? Deferred.succeed(request.decision, "cancel")
            : Deferred.succeed(request.answers, null);
          if (!cancelled) return;

          yield* ctx.emitProviderEvent({
            type: "runtime_request.updated",
            driver: ctx.driver,
            threadId: request.node.threadId,
            runtimeRequest: {
              ...request.runtimeRequest,
              status: "cancelled",
              resolvedAt: now,
            },
          });
          yield* ctx.emitProviderEvent({
            type: "node.updated",
            driver: ctx.driver,
            node: {
              ...request.node,
              status: "cancelled",
              completedAt: now,
            },
          });
          yield* ctx.emitProviderEvent({
            type: "turn_item.updated",
            driver: ctx.driver,
            turnItem: {
              ...request.turnItem,
              status: "cancelled",
              completedAt: now,
              updatedAt: now,
            },
          });
        }),
      { concurrency: 1, discard: true },
    );
  });
  return {
    activeContext,
    beginApprovalRequest,
    beginUserInputRequest,
    requestUserInputWithAdmission,
  };
};
