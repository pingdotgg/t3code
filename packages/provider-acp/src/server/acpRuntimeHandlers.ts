// ACP session behaviour extracted from server/adapter.ts (runtimeHandlers).

import {
  acpPermissionDisposition,
  unknownRecord,
  acpMcpToolApprovalElicitationDisposition,
} from "./clientPolicy.ts";
import {
  selectAutoApprovedPermissionOption,
  selectPermissionOptionId,
  providerRequestKind,
  nonEmptyText,
  elicitationContent,
} from "./acpToolCallProjection.ts";
import { type AcpAdapterV2UserInputRequest } from "./acpAdapterConfig.ts";
import { type OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import { withTrackedPermissionToolCall, parsePermissionRequest } from "./runtimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpProtocol from "effect-acp/protocol";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Option from "effect/Option";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AcpSessionCtx15 } from "./acpSessionContext.ts";

export const createAcpRuntimeHandlers = (ctx: AcpSessionCtx15) => {
  const wireAcpRuntimeHandlers = Effect.fnUntraced(function* (
    targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    handlerGeneration: number,
    handlerOptions: {
      readonly sessionUpdates?: boolean;
      readonly terminals?: boolean;
      readonly mcp?: boolean;
      readonly scope?: Scope.Scope;
    } = {},
  ) {
    yield* targetRuntime.getEvents().pipe(
      Stream.runForEach((event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        return ctx.runRuntimeCallbackAtGeneration(
          handlerGeneration,
          ctx.flavor.onSessionEvent?.(event) ?? Effect.void,
        ).pipe(Effect.asVoid);
      }),
      Effect.forkIn(handlerOptions.scope ?? ctx.runtimeScope ?? ctx.sessionScope),
    );
    const requestUserInput = (
      request: AcpAdapterV2UserInputRequest,
      requestContext: EffectAcpProtocol.AcpRequestContext,
    ) =>
      ctx.requestUserInputWithAdmission(
        handlerGeneration,
        Effect.succeed(request),
        requestContext.requestId,
      );
    const clientFileSystem = ctx.flavor.clientFileSystem;
    if (clientFileSystem !== undefined) {
      yield* targetRuntime.handleReadTextFile((request) =>
        ctx.clientPolicyContext.pipe(
          Effect.flatMap(({ policy }) => clientFileSystem.readTextFile(request, policy.cwd)),
        ),
      );
      const writeTextFile = clientFileSystem.writeTextFile;
      if (writeTextFile !== undefined) {
        yield* targetRuntime.handleWriteTextFile((request) =>
          ctx.clientPolicyContext.pipe(
            Effect.flatMap(({ policy }) => writeTextFile(request, policy.cwd)),
          ),
        );
      }
    }
    if (handlerOptions.mcp !== false) {
      yield* ctx.wireAcpRuntimeMcpHandlers(targetRuntime, ctx.runtimeMcpBridge);
    }
    if (handlerOptions.terminals !== false) {
      yield* ctx.wireAcpRuntimeTerminalHandlers(targetRuntime);
    }
    if (handlerOptions.sessionUpdates !== false) {
      yield* targetRuntime.handleSessionUpdate((rawNotification) =>
        ctx.projectAcpRuntimeSessionUpdate(handlerGeneration, rawNotification),
      );
    }
    yield* targetRuntime.handleRequestPermission((nativeParams, requestContext) =>
      Effect.gen(function* () {
        const trackedTurn = yield* Ref.get(ctx.activeTurn);
        const params =
          trackedTurn !== null && nativeParams.sessionId === (yield* Ref.get(ctx.activeSessionId))
            ? withTrackedPermissionToolCall(
                nativeParams,
                trackedTurn.tools.get(nativeParams.toolCall.toolCallId),
              )
            : nativeParams;
        const transportRequestId = requestContext.requestId;
        const permissionQuestion = ctx.flavor.extractPermissionQuestion?.(params);
        if (permissionQuestion !== undefined) {
          const userInput = yield* ctx.requestUserInputWithAdmission(
            handlerGeneration,
            Effect.succeed({
              nativeItemId: `${params.sessionId}:question:${params.toolCall.toolCallId}`,
              nativeMethod: "session/request_permission",
              nativeRequestId: params.toolCall.toolCallId,
              nativeSessionId: params.sessionId,
              questions: [permissionQuestion.question],
            }),
            transportRequestId,
          );
          const response =
            userInput.answers === null
              ? undefined
              : permissionQuestion.respond(userInput.answers);
          yield* userInput.acknowledgeNativeResponse;
          return response ?? ({ outcome: { outcome: "cancelled" } } as const);
        }
        const dispositionFor = (
          policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
          request: EffectAcpSchema.RequestPermissionRequest = params,
        ) => (ctx.flavor.permissionDisposition ?? acpPermissionDisposition)(policy, request);
        if (ctx.followsAgentWorkState && dispositionFor(ctx.latestRuntimePolicy) === "ask") {
          if (!(yield* ctx.awaitRequestTurn(handlerGeneration)))
            return { outcome: { outcome: "cancelled" } } as const;
        }
        const admitted = yield* ctx.runRuntimeCallbackAtGeneration(
          handlerGeneration,
          Effect.gen(function* () {
            const context = ctx.followsAgentWorkState
              ? yield* Ref.get(ctx.activeTurn)
              : yield* ctx.activeContext;
            // Kiro sends the tool's kind on its `tool_call` and leaves it
            // off the permission request for that call; take it from the
            // tool already seen under the same id so policy can tell a
            // read from a write.
            const knownKind = context?.tools.get(params.toolCall.toolCallId)?.kind;
            const disposition = dispositionFor(
              context?.input.runtimePolicy ?? ctx.latestRuntimePolicy,
              params.toolCall.kind == null && knownKind !== undefined
                ? { ...params, toolCall: { ...params.toolCall, kind: knownKind } }
                : params,
            );
            if (disposition === "allow") {
              const optionId = selectAutoApprovedPermissionOption(params);
              return {
                _tag: "Immediate" as const,
                response:
                  optionId === undefined
                    ? ({ outcome: { outcome: "cancelled" } } as const)
                    : ({ outcome: { outcome: "selected", optionId } } as const),
              };
            }
            if (disposition === "deny") {
              const optionId = selectPermissionOptionId(params, "decline");
              return {
                _tag: "Immediate" as const,
                response:
                  optionId === undefined
                    ? ({ outcome: { outcome: "cancelled" } } as const)
                    : ({ outcome: { outcome: "selected", optionId } } as const),
              };
            }
            return {
              _tag: "Pending" as const,
              pending: yield* ctx.beginApprovalRequest(
                yield* ctx.activeContext,
                params,
                handlerGeneration,
                transportRequestId,
              ),
            };
          }),
        );
        if (Option.isNone(admitted)) {
          return yield* Effect.never;
        }
        if (admitted.value._tag === "Immediate") {
          const response = admitted.value.response;
          const checked = yield* ctx.runRuntimeCallbackAtGeneration(
            handlerGeneration,
            Effect.gen(function* () {
              const nativeResponseAcknowledgement = yield* Deferred.make<
                void,
                EffectAcpErrors.AcpError
              >();
              yield* ctx.registerNativeResponseAcknowledgement(
                handlerGeneration,
                transportRequestId,
                nativeResponseAcknowledgement,
              );
              return response;
            }),
          );
          return Option.isSome(checked) ? checked.value : yield* Effect.never;
        }
        const {
          context,
          decision: pendingDecision,
          requestId,
          transportRequestId: pendingTransportRequestId,
        } = admitted.value.pending;
        const parsedPermission = parsePermissionRequest(params);
        const answered = yield* Deferred.await(pendingDecision).pipe(
          Effect.ensuring(
            ctx.runRuntimeCallbackAtGeneration(
              handlerGeneration,
              Ref.update(ctx.pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(requestId));
                return updated;
              }),
            ).pipe(Effect.asVoid),
          ),
        );
        // A card that never offered "this session" (Kiro's, whose
        // allow_always saves a workspace rule) cannot be answered with
        // it by a stale client or a hand-made respond call.
        const offeredOptions = ctx.flavor.approvalOptions?.(params);
        const decision =
          answered === "acceptForSession" &&
          offeredOptions !== undefined &&
          !offeredOptions.some((option) => option.decision === "acceptForSession")
            ? "accept"
            : answered;
        if (
          parsedPermission.kind !== "unknown" &&
          (decision === "accept" || decision === "acceptForSession")
        ) {
          ctx.clientPolicyGrants.recordApproval({
            kind: providerRequestKind(parsedPermission.kind),
            scope: decision === "acceptForSession" ? "session" : "turn",
            turnKey: String(context.providerTurnId),
          });
        }
        const response = (() => {
          if (decision === "cancel") {
            return { outcome: { outcome: "cancelled" } } as const;
          }
          const optionId = selectPermissionOptionId(params, decision);
          return optionId === undefined
            ? ({ outcome: { outcome: "cancelled" } } as const)
            : ({ outcome: { outcome: "selected", optionId } } as const);
        })();
        const checked = yield* ctx.runRuntimeCallbackAtGeneration(
          handlerGeneration,
          Effect.succeed(response),
        );
        if (Option.isNone(checked)) return yield* Effect.never;
        yield* ctx.acknowledgeNativeResponse(handlerGeneration, pendingTransportRequestId);
        return checked.value;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to handle an ACP permission request",
              cause,
            }),
        ),
        ctx.holdingAgentRequest(handlerGeneration),
      ),
    );
    yield* targetRuntime.handleElicitation((params, requestContext) =>
      Effect.gen(function* () {
        const transportRequestId = requestContext.requestId;
        if (
          params.mode === "form" &&
          (unknownRecord(params._meta)?.codex_approval_kind === "mcp_tool_call" ||
            transportRequestId.startsWith("mcp_tool_call_approval_"))
        ) {
          const mcpApprovalDisposition = yield* ctx.runRuntimeCallbackAtGeneration(
            handlerGeneration,
            Effect.gen(function* () {
              const context = yield* ctx.activeContext;
              const disposition = acpMcpToolApprovalElicitationDisposition(
                context.input.runtimePolicy,
                params,
                transportRequestId,
              );
              if (disposition === undefined || disposition === "ask") {
                return disposition;
              }
              const nativeResponseAcknowledgement = yield* Deferred.make<
                void,
                EffectAcpErrors.AcpError
              >();
              yield* ctx.registerNativeResponseAcknowledgement(
                handlerGeneration,
                transportRequestId,
                nativeResponseAcknowledgement,
              );
              return disposition;
            }),
          );
          if (Option.isNone(mcpApprovalDisposition)) return yield* Effect.never;
          if (mcpApprovalDisposition.value === "allow") {
            return { action: "accept", content: {} } as const;
          }
        }
        if (
          params.mode === "url" &&
          "url" in params &&
          typeof params.url === "string" &&
          "elicitationId" in params &&
          typeof params.elicitationId === "string"
        ) {
          const { elicitationId, url } = params;
          const admitted = yield* ctx.runRuntimeCallbackAtGeneration(
            handlerGeneration,
            Effect.gen(function* () {
              const nativeResponseAcknowledgement = yield* Deferred.make<
                void,
                EffectAcpErrors.AcpError
              >();
              yield* ctx.registerNativeResponseAcknowledgement(
                handlerGeneration,
                transportRequestId,
                nativeResponseAcknowledgement,
              );
              const accepted = yield* (
                ctx.flavor.onUrlElicitation?.({
                  elicitationId,
                  url,
                  message: params.message,
                }) ?? Effect.succeed(false)
              );
              return accepted
                ? ({ action: "accept" } as const)
                : ({ action: "decline" } as const);
            }),
          );
          if (Option.isNone(admitted)) return yield* Effect.never;
          return admitted.value;
        }
        if (params.mode !== "form" || !("requestedSchema" in params)) {
          return { action: "decline" } as const;
        }
        const requestedSchema = unknownRecord(params.requestedSchema);
        const properties = unknownRecord(requestedSchema?.properties) ?? {};
        const nativeForm = ctx.flavor.extractElicitationForm?.(params);
        const elicitationScopeId =
          "sessionId" in params ? params.sessionId : `request:${params.requestId}`;
        const questions =
          nativeForm?.questions ??
          Object.entries(properties).map(
            ([id, property], index): OrchestrationV2UserInputQuestion => {
              const record = unknownRecord(property);
              const enumValues = Array.isArray(record?.enum)
                ? record.enum.filter((value): value is string => typeof value === "string")
                : [];
              const options =
                enumValues.length > 0
                  ? enumValues.map((value) => ({ label: value, description: value }))
                  : record?.type === "boolean"
                    ? [
                        { label: "true", description: "Yes" },
                        { label: "false", description: "No" },
                      ]
                    : [];
              return {
                id,
                header: nonEmptyText(record?.title, `Question ${index + 1}`),
                question: nonEmptyText(record?.description, params.message),
                options,
              };
            },
          );
        const userInput = yield* ctx.requestUserInputWithAdmission(
          handlerGeneration,
          Effect.gen(function* () {
            const ordinal = yield* Ref.getAndUpdate(
              ctx.nextElicitationOrdinal,
              (current) => current + 1,
            );
            const nativeRequestId = `${elicitationScopeId}:elicitation:${ordinal}`;
            return {
              nativeItemId: nativeRequestId,
              nativeRequestId,
              questions,
            };
          }),
          transportRequestId,
        );
        const response =
          userInput.answers === null
            ? ({ action: "cancel" } as const)
            : (nativeForm?.respond(userInput.answers) ??
              ({
                action: "accept",
                content: elicitationContent(
                  userInput.answers,
                  new Set(Object.keys(properties)),
                ),
              } as const));
        yield* userInput.acknowledgeNativeResponse;
        return response;
      }).pipe(ctx.holdingAgentRequest(handlerGeneration)),
    );
    if (ctx.flavor.registerExtensions !== undefined) {
      yield* ctx.flavor.registerExtensions({
        runtime: targetRuntime,
        reportProviderRetry: (notice) =>
          ctx.runRuntimeCallbackAtGeneration(handlerGeneration, ctx.reportProviderRetry(notice)).pipe(
            Effect.asVoid,
          ),
        requestUserInput,
        captureProposedPlan: ctx.captureProposedPlan,
        lastProposedPlanMarkdown: ctx.lastProposedPlanMarkdown,
        finishSubagent: (notice) =>
          ctx.runRuntimeCallbackAtGeneration(
            handlerGeneration,
            Effect.gen(function* () {
              if (yield* Ref.get(ctx.stoppedRunQuarantine)) return;
              if ((yield* Ref.get(ctx.activeSessionId)) !== notice.sessionId) return;
              yield* ctx.finishSubagentFromNotice(notice);
            }),
          ).pipe(Effect.asVoid),
        applyBackgroundTaskMutation: (incoming) =>
          ctx.runRuntimeCallbackAtGeneration(
            handlerGeneration,
            Effect.gen(function* () {
              if (yield* Ref.get(ctx.stoppedRunQuarantine)) return;
              if ((yield* Ref.get(ctx.activeSessionId)) !== incoming.sessionId) return;
              const context = yield* Ref.get(ctx.activeTurn);
              let mutation = incoming;
              if (
                incoming.status !== "running" &&
                context !== null &&
                !context.finalized &&
                (incoming.report?.kind === "command" ||
                  context.backgroundCommands.has(incoming.taskId))
              ) {
                const previous = context.backgroundCommands.get(incoming.taskId);
                const toolCallId = context.toolCallIdsByBackgroundTaskId.get(incoming.taskId);
                const tool =
                  toolCallId === undefined ? undefined : context.tools.get(toolCallId);
                const output =
                  incoming.output ??
                  previous?.output ??
                  (tool === undefined ? undefined : ctx.toolOutputText(tool));
                // Missing exit codes decode as success; they cannot undo a known failure.
                const completion = {
                  status: previous?.status === "failed" ? "failed" : incoming.status,
                  ...(output === undefined ? {} : { output }),
                };
                context.backgroundCommands.set(incoming.taskId, completion);
                mutation = { ...incoming, ...completion };
              }
              if (
                mutation.status !== "running" &&
                mutation.report !== undefined &&
                !(yield* Ref.get(ctx.handledBackgroundTaskIdsInActiveTurn)).has(mutation.taskId)
              ) {
                yield* ctx.recordWakeReport(mutation.taskId, {
                  ...mutation.report,
                  outcome: mutation.status,
                });
              }
              yield* ctx.applyLateBackgroundMutation(mutation.sessionId, mutation);
              if (mutation.status !== "running") {
                yield* ctx.finishRegisteredBackgroundTool({
                  taskId: mutation.taskId,
                  status: mutation.status,
                  ...(mutation.output === undefined ? {} : { output: mutation.output }),
                });
              }
            }),
          ).pipe(Effect.asVoid),
      });
    }
  });
  return {
    wireAcpRuntimeHandlers,
  };
};
