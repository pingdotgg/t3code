import {
  ApprovalRequestId,
  EventId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProviderInstanceId,
  type ProviderTurnStartResult,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "./AcpAdapterSupport.ts";
import {
  appendPromptResultToTurn,
  emitAcpSessionReadyEvents,
  forkAcpAdapterNotificationStream,
  handleAcpPermissionRequest,
  makeAcpPromptSettler,
  makeAcpThreadLock,
  parseAcpResume,
  prepareAcpPromptContent,
  respondToAcpPermissionRequest,
  respondToAcpUserInput,
  settlePendingAcpApprovalsAsCancelled,
  settlePendingAcpUserInputsAsCancelled,
  type AcpAdapterPendingApproval,
  type AcpAdapterPendingUserInput,
  type AcpAdapterSessionContext,
} from "./AcpAdapterRuntime.ts";
import { makeAcpNativeLoggerFactory } from "./AcpNativeLogging.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";

export interface AcpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly afterSessionStarted?: (input: {
    readonly threadId: ThreadId;
    readonly sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];
  }) => Effect.Effect<void>;
}

export interface AcpAdapterLiveSessionContext<
  UserInputResponse = unknown,
> extends AcpAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, AcpAdapterPendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, AcpAdapterPendingUserInput<UserInputResponse>>;
  readonly promptCapabilities: EffectAcpSchema.PromptCapabilities | undefined;
  currentModelId: string | undefined;
  stopped: boolean;
}

export interface AcpAdapterLiveCallbackContext<UserInputResponse> {
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly pendingApprovals: Map<ApprovalRequestId, AcpAdapterPendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, AcpAdapterPendingUserInput<UserInputResponse>>;
  readonly resolveActiveTurnId: () => TurnId | undefined;
  readonly mapAcpCallbackFailure: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, EffectAcpErrors.AcpTransportError, R>;
  readonly nextApprovalRequestId: Effect.Effect<ApprovalRequestId, ProviderAdapterRequestError>;
  readonly makeEventStamp: () => Effect.Effect<
    { readonly eventId: EventId; readonly createdAt: string },
    ProviderAdapterRequestError
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly logNative: (threadId: ThreadId, method: string, payload: unknown) => Effect.Effect<void>;
}

export interface AcpAdapterLiveModelBinding {
  readonly currentModelId: string | undefined;
  readonly displayModel: string | undefined;
}

export interface AcpAdapterLiveConfig<UserInputResponse> {
  readonly provider: ProviderDriverKind;
  readonly providerLabel: string;
  readonly resumeSchemaVersion: number;
  readonly readyReason: string;
  readonly respondToUserInputMethod: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly completedStopReasonFromPromptResponse: (
    response: EffectAcpSchema.PromptResponse,
  ) => EffectAcpSchema.StopReason | null;
  readonly makeAcpRuntime: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly resumeSessionId: string | undefined;
    readonly sessionScope: Scope.Closeable;
    readonly acpNativeLoggers: Pick<
      AcpSessionRuntime.AcpSessionRuntimeOptions,
      "requestLogger" | "protocolLogging"
    >;
    readonly mcpServers: AcpSessionRuntime.AcpSessionRuntimeOptions["mcpServers"];
  }) => Effect.Effect<AcpSessionRuntime.AcpSessionRuntime["Service"], ProviderAdapterProcessError>;
  readonly registerAcpCallbacks: (
    input: AcpAdapterLiveCallbackContext<UserInputResponse>,
  ) => Effect.Effect<void>;
  readonly bindSessionModel: (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode: ProviderSession["runtimeMode"];
    readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly modelSelection: ModelSelection | undefined;
    readonly sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"];
  }) => Effect.Effect<AcpAdapterLiveModelBinding, ProviderAdapterError>;
  readonly prepareTurnModel: (input: {
    readonly threadId: ThreadId;
    readonly ctx: AcpAdapterLiveSessionContext<UserInputResponse>;
    readonly modelSelection: ModelSelection | undefined;
    readonly interactionMode: ProviderSendTurnInput["interactionMode"];
  }) => Effect.Effect<AcpAdapterLiveModelBinding, ProviderAdapterError>;
}

export function makeAcpAdapterLive<UserInputResponse>(
  config: AcpAdapterLiveConfig<UserInputResponse>,
  options?: AcpAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make(config.provider);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, AcpAdapterLiveSessionContext<UserInputResponse>>();
    const threadLock = yield* makeAcpThreadLock();
    const withThreadLock = threadLock.withThreadLock;
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: config.provider,
            method: "crypto/randomUUIDv4",
            detail: `Failed to generate ${config.providerLabel} runtime identifier.`,
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const nextApprovalRequestId = Effect.map(randomUUIDv4, (id) => ApprovalRequestId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: `Failed to process ${config.providerLabel} ACP callback.`,
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const settlePromptInFlight = makeAcpPromptSettler({
      provider: config.provider,
      sessions,
      nowIso,
      makeEventStamp,
      offerRuntimeEvent,
    });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: config.provider,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Failed to write native ${config.providerLabel} notification log.`, {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<
      AcpAdapterLiveSessionContext<UserInputResponse>,
      ProviderAdapterSessionNotFoundError
    > => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: config.provider, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AcpAdapterLiveSessionContext<UserInputResponse>) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingAcpApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingAcpUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: config.provider,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession = (input: ProviderSessionStartInput) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== config.provider) {
            return yield* new ProviderAdapterValidationError({
              provider: config.provider,
              operation: "startSession",
              issue: `Expected provider '${config.provider}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: config.provider,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const boundModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);

          const pendingApprovals = new Map<ApprovalRequestId, AcpAdapterPendingApproval>();
          const pendingUserInputs = new Map<
            ApprovalRequestId,
            AcpAdapterPendingUserInput<UserInputResponse>
          >();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseAcpResume(
            input.resumeCursor,
            config.resumeSchemaVersion,
          )?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: config.provider,
            threadId: input.threadId,
          });

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* config.makeAcpRuntime({
            threadId: input.threadId,
            cwd,
            resumeSessionId,
            sessionScope,
            acpNativeLoggers,
            mcpServers: mcpSession
              ? [
                  {
                    type: "http" as const,
                    name: "t3-code",
                    url: mcpSession.endpoint,
                    headers: [
                      {
                        name: "Authorization",
                        value: mcpSession.authorizationHeader,
                      },
                    ],
                  },
                ]
              : undefined,
          });

          const resolveActiveTurnId = () => sessions.get(input.threadId)?.activeTurnId;
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                handleAcpPermissionRequest({
                  provider: config.provider,
                  threadId: input.threadId,
                  runtimeMode: input.runtimeMode,
                  request: params,
                  pendingApprovals,
                  resolveTurnId: resolveActiveTurnId,
                  makeRequestId: nextApprovalRequestId,
                  makeEventStamp,
                  offerRuntimeEvent,
                  logNative,
                }),
              ),
            );
            yield* config.registerAcpCallbacks({
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              acp,
              pendingApprovals,
              pendingUserInputs,
              resolveActiveTurnId,
              mapAcpCallbackFailure,
              nextApprovalRequestId,
              makeEventStamp,
              offerRuntimeEvent,
              logNative,
            });
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(config.provider, input.threadId, "session/start", error),
            ),
          );

          yield* (
            options?.afterSessionStarted?.({
              threadId: input.threadId,
              sessionSetupResult: started.sessionSetupResult,
            }) ?? Effect.void
          );

          const { currentModelId, displayModel } = yield* config.bindSessionModel({
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            acp,
            modelSelection: boundModelSelection,
            sessionSetupResult: started.sessionSetupResult,
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: config.provider,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(displayModel ? { model: displayModel } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: config.resumeSchemaVersion,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: AcpAdapterLiveSessionContext<UserInputResponse> = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            promptCapabilities: started.initializeResult.agentCapabilities?.promptCapabilities,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId,
            stopped: false,
          };

          const nf = yield* forkAcpAdapterNotificationStream({
            provider: config.provider,
            ctx,
            events: acp.getEvents(),
            makeEventStamp,
            offerRuntimeEvent,
            logNative,
            logErrorMessage: `Failed to process ${config.providerLabel} runtime notification.`,
          });

          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* emitAcpSessionReadyEvents({
            provider: config.provider,
            threadId: input.threadId,
            providerThreadId: started.sessionId,
            initializeResult: started.initializeResult,
            readyReason: config.readyReason,
            makeEventStamp,
            offerRuntimeEvent,
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        // Created before the prompt slot is acquired so the settlement
        // `ensuring` below is armed without an interruption window that could
        // leak `promptsInFlight`.
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );
        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            ctx.promptsInFlight += 1;
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const boundModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const promptParts = yield* prepareAcpPromptContent({
                provider: config.provider,
                text: input.input,
                attachments: input.attachments,
                promptCapabilities: ctx.promptCapabilities,
                attachmentsDir: serverConfig.attachmentsDir,
                fileSystem,
              });

              const { currentModelId, displayModel } = yield* config.prepareTurnModel({
                threadId: input.threadId,
                ctx,
                modelSelection: boundModelSelection,
                interactionMode: input.interactionMode,
              });

              ctx.currentModelId = currentModelId;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: config.provider,
                  method: "session/prompt",
                  detail: `${config.providerLabel} prompt was interrupted during preparation.`,
                });
              }
              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: config.provider,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: `${config.providerLabel} prompt preparation failed.`,
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );

        return yield* Effect.gen(function* () {
          const result = yield* prepared.acp
            .prompt({
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(config.provider, input.threadId, "session/prompt", error)
                    .message,
                ).pipe(Effect.andThen(prepared.acp.drainEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(config.provider, input.threadId, "session/prompt", error),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: `${config.providerLabel} session changed before the turn completed.`,
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: config.provider,
                  method: "session/prompt",
                  detail: `${config.providerLabel} session changed before the turn completed.`,
                });
              }
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.drainEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                } satisfies ProviderTurnStartResult;
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                } satisfies ProviderTurnStartResult;
              }

              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
                  yield* Ref.set(promptSettled, true);
                  ctx.session = {
                    ...ctx.session,
                    status: "running",
                    activeTurnId: prepared.turnId,
                    updatedAt: yield* nowIso,
                    ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                  };
                  const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
                  ctx.promptsInFlight = remainingPrompts;

                  if (
                    remainingPrompts === 0 &&
                    ctx.activeTurnId === prepared.turnId &&
                    ctx.session.activeTurnId === prepared.turnId
                  ) {
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return {
                        threadId: input.threadId,
                        turnId: prepared.turnId,
                        resumeCursor: ctx.session.resumeCursor,
                      } satisfies ProviderTurnStartResult;
                    }
                    const completedAt = yield* nowIso;
                    const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                    ctx.activeTurnId = undefined;
                    ctx.session = {
                      ...readySession,
                      status: "ready",
                      updatedAt: completedAt,
                      ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                    };
                    const completedStopReason =
                      config.completedStopReasonFromPromptResponse(result);
                    yield* offerRuntimeEvent({
                      type: "turn.completed",
                      ...(yield* makeEventStamp()),
                      provider: config.provider,
                      threadId: input.threadId,
                      turnId: prepared.turnId,
                      payload: {
                        state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                        stopReason: completedStopReason,
                      },
                    });
                    ctx.interruptedTurnIds.delete(prepared.turnId);
                  }

                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  } satisfies ProviderTurnStartResult;
                }),
              );
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);
                if (promptResult === undefined) {
                  return;
                }
                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);
                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: `${config.providerLabel} session changed before the turn completed.`,
                          settleAllPrompts: true,
                        },
                      );
                      return;
                    }
                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }
                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }
                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason:
                          config.completedStopReasonFromPromptResponse(promptResult),
                      },
                    );
                  }),
                );
                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? `${config.providerLabel} prompt request failed.`,
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }
        if (observed.acpSessionId === undefined) {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingAcpApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingAcpUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(config.provider, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: Parameters<ProviderAdapterShape<ProviderAdapterError>["respondToRequest"]>[2],
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* respondToAcpPermissionRequest({
          provider: config.provider,
          requestId,
          decision,
          pendingApprovals: ctx.pendingApprovals,
        });
      });

    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: Parameters<ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"]>[2],
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* respondToAcpUserInput({
          provider: config.provider,
          method: config.respondToUserInputMethod,
          requestId,
          answers,
          pendingUserInputs: ctx.pendingUserInputs,
        });
      });

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread = (threadId: ThreadId, numTurns: number) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: config.provider,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: config.provider,
          method: "thread/rollback",
          detail: `${config.providerLabel} ACP sessions do not support provider-side rollback yet.`,
        });
      });

    const stopSession = (threadId: ThreadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
          yield* threadLock.deleteThreadLock(threadId);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // Take each thread lock so a stop never interrupts the notification fiber
    // while a locked `sendTurn` section is waiting on an event-stream barrier.
    const stopAll = () =>
      Effect.forEach(
        Array.from(sessions.keys()),
        (threadId) =>
          withThreadLock(
            threadId,
            Effect.suspend(() => {
              const ctx = sessions.get(threadId);
              return ctx
                ? Effect.gen(function* () {
                    yield* stopSessionInternal(ctx);
                    yield* threadLock.deleteThreadLock(threadId);
                  })
                : Effect.void;
            }),
          ),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: config.provider,
      capabilities: config.capabilities,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
