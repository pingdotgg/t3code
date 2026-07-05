import {
  type ApprovalRequestId,
  type DevinSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  type AcpAdapterPendingUserInput,
  acpPromptSettlementBelongsToContext,
  handleAcpUserInputRequest,
} from "../acp/AcpAdapterRuntime.ts";
import { makeAcpAdapterLive, type AcpAdapterLiveOptions } from "../acp/AcpAdapterLive.ts";
import {
  applyDevinAcpModelSelection,
  applyDevinRequestedMode,
  buildDevinDiscoveredModelsFromSessionSetup,
  currentDevinModelIdFromSessionSetup,
  makeDevinAcpRuntime,
  resolveDevinAcpDisplayModelId,
  resolveDevinAcpModelSelection,
} from "../acp/DevinAcpSupport.ts";
import {
  makeDevinAskQuestionPrompt,
  methodLooksLikeDevinAskQuestion,
  type DevinAskQuestionResponse,
} from "../acp/DevinAcpExtension.ts";
import { makeDevinElicitationPrompt } from "../acp/DevinElicitation.ts";
import { ProviderAdapterProcessError, type ProviderAdapterRequestError } from "../Errors.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_RESUME_VERSION = 1 as const;

export interface DevinAdapterLiveOptions extends AcpAdapterLiveOptions {
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly onSessionModelsDiscovered?: (
    models: ReadonlyArray<ServerProviderModel>,
  ) => Effect.Effect<void>;
}

export const devinPromptSettlementBelongsToContext = acpPromptSettlementBelongsToContext;

export function makeDevinAdapter(devinSettings: DevinSettings, options?: DevinAdapterLiveOptions) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* makeAcpAdapterLive<
      EffectAcpSchema.ElicitationResponse | DevinAskQuestionResponse
    >(
      {
        provider: PROVIDER,
        providerLabel: "Devin",
        resumeSchemaVersion: DEVIN_RESUME_VERSION,
        readyReason: "Devin ACP session ready",
        respondToUserInputMethod: "session/elicitation",
        capabilities: { sessionModelSwitch: "in-session" },
        completedStopReasonFromPromptResponse: (response) => response?.stopReason ?? null,
        makeAcpRuntime: (input) =>
          makeDevinAcpRuntime({
            devinSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd: input.cwd,
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
            ...input.acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, input.sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          ),
        registerAcpCallbacks: (input) =>
          Effect.gen(function* () {
            // URL-mode elicitations can be completed out-of-band by the agent
            // (session/elicitation/complete), so track their request ids.
            const urlElicitationRequestIds = new Map<string, ApprovalRequestId>();
            const pendingElicitations = input.pendingUserInputs as Map<
              ApprovalRequestId,
              AcpAdapterPendingUserInput<EffectAcpSchema.ElicitationResponse>
            >;
            const pendingAskQuestions = input.pendingUserInputs as Map<
              ApprovalRequestId,
              AcpAdapterPendingUserInput<DevinAskQuestionResponse>
            >;
            yield* input.acp.handleElicitation((params) => {
              const elicitationId = params.mode === "url" ? params.elicitationId : undefined;
              return input.mapAcpCallbackFailure(
                handleAcpUserInputRequest<
                  EffectAcpSchema.ElicitationResponse,
                  ProviderAdapterRequestError,
                  never,
                  ProviderAdapterRequestError
                >({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  method: "session/elicitation",
                  source: "acp.jsonrpc",
                  request: params,
                  prompt: {
                    ...makeDevinElicitationPrompt(params),
                    makeCancelledResponse: () =>
                      ({
                        action: { action: "cancel" },
                      }) satisfies EffectAcpSchema.ElicitationResponse,
                    validateResponse: (response) =>
                      response.action.action === "decline"
                        ? "Invalid Devin elicitation response: missing required answers."
                        : undefined,
                  },
                  pendingUserInputs: pendingElicitations,
                  ...(elicitationId !== undefined
                    ? {
                        onOpened: (requestId: ApprovalRequestId) => {
                          urlElicitationRequestIds.set(elicitationId, requestId);
                        },
                        onSettled: () => {
                          urlElicitationRequestIds.delete(elicitationId);
                        },
                      }
                    : {}),
                  resolveTurnId: input.resolveActiveTurnId,
                  makeRequestId: input.nextApprovalRequestId,
                  makeEventStamp: input.makeEventStamp,
                  offerRuntimeEvent: input.offerRuntimeEvent,
                  logNative: input.logNative,
                }),
              );
            });
            yield* input.acp.handleElicitationComplete((notification) =>
              Effect.suspend(() => {
                const requestId = urlElicitationRequestIds.get(notification.elicitationId);
                const pending =
                  requestId !== undefined ? input.pendingUserInputs.get(requestId) : undefined;
                if (!pending) {
                  return Effect.void;
                }
                return Deferred.succeed(pending.resolution, {
                  _tag: "answered",
                  answers: {},
                  response: { action: { action: "accept" } },
                }).pipe(Effect.asVoid);
              }),
            );
            yield* input.acp.handleUnknownExtRequest((method, params) => {
              if (!methodLooksLikeDevinAskQuestion(method)) {
                return Effect.fail(EffectAcpErrors.AcpRequestError.methodNotFound(method));
              }
              const prompt = makeDevinAskQuestionPrompt(params);
              if (!prompt) {
                return Effect.fail(
                  EffectAcpErrors.AcpRequestError.invalidParams(
                    "Invalid Devin ask-question payload",
                    params,
                  ),
                );
              }
              return input.mapAcpCallbackFailure(
                handleAcpUserInputRequest<
                  DevinAskQuestionResponse,
                  ProviderAdapterRequestError,
                  never,
                  ProviderAdapterRequestError
                >({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  method,
                  source: "acp.devin.extension",
                  request: params,
                  prompt,
                  pendingUserInputs: pendingAskQuestions,
                  resolveTurnId: input.resolveActiveTurnId,
                  makeRequestId: input.nextApprovalRequestId,
                  makeEventStamp: input.makeEventStamp,
                  offerRuntimeEvent: input.offerRuntimeEvent,
                  logNative: input.logNative,
                }),
              );
            });
          }),
        bindSessionModel: (input) =>
          Effect.gen(function* () {
            const requestedStartModelId = input.modelSelection
              ? resolveDevinAcpModelSelection({
                  configOptions: input.sessionSetupResult.configOptions,
                  model: input.modelSelection.model,
                  selections: input.modelSelection.options,
                })
              : undefined;
            const sessionSetupModelId = currentDevinModelIdFromSessionSetup(
              input.sessionSetupResult,
            );
            const boundModelId = yield* applyDevinAcpModelSelection({
              runtime: input.acp,
              currentModelId: sessionSetupModelId,
              requestedModelId: requestedStartModelId,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
            });
            yield* applyDevinRequestedMode({
              runtime: input.acp,
              runtimeMode: input.runtimeMode,
              interactionMode: undefined,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
            });
            const activeAcpModelId = boundModelId ?? sessionSetupModelId;
            return {
              currentModelId: activeAcpModelId,
              displayModel: activeAcpModelId
                ? resolveDevinAcpDisplayModelId(
                    input.sessionSetupResult.configOptions,
                    activeAcpModelId,
                  )
                : undefined,
            };
          }),
        prepareTurnModel: (input) =>
          Effect.gen(function* () {
            const configOptions = yield* input.ctx.acp.getConfigOptions;
            const requestedTurnModelId = input.modelSelection
              ? resolveDevinAcpModelSelection({
                  configOptions,
                  model: input.modelSelection.model,
                  selections: input.modelSelection.options,
                })
              : undefined;
            const currentModelId = yield* applyDevinAcpModelSelection({
              runtime: input.ctx.acp,
              currentModelId: input.ctx.currentModelId,
              requestedModelId: requestedTurnModelId,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
            });
            yield* applyDevinRequestedMode({
              runtime: input.ctx.acp,
              runtimeMode: input.ctx.session.runtimeMode,
              interactionMode: input.interactionMode,
              mapError: (cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
            });
            return {
              currentModelId,
              displayModel: currentModelId
                ? resolveDevinAcpDisplayModelId(configOptions, currentModelId)
                : undefined,
            };
          }),
      },
      {
        ...options,
        afterSessionStarted: (input) =>
          Effect.gen(function* () {
            const discoveredModels = buildDevinDiscoveredModelsFromSessionSetup(
              input.sessionSetupResult,
            );
            yield* (options?.onSessionModelsDiscovered?.(discoveredModels) ?? Effect.void).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to record Devin ACP session model discovery.", {
                  cause,
                }),
              ),
            );
            yield* options?.afterSessionStarted?.(input) ?? Effect.void;
          }),
      },
    );
  });
}
