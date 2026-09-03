import {
  ApprovalRequestId,
  type DevinSettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { expandHomePath } from "../../pathExpansion.ts";

import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import {
  applyDevinAcpModelSelection,
  buildDevinModelsFromSessionModelState,
  currentDevinModelIdFromSessionSetup,
  DEVIN_DEFAULT_MODEL_SLUG_PUBLIC,
  makeDevinAcpRuntime,
  resolveDevinAcpBaseModelId,
  resolveDevinAcpMode,
} from "../acp/DevinAcpSupport.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { type DevinAdapterShape } from "../Services/DevinAdapter.ts";

const PROVIDER = ProviderDriverKind.make("devin");
const DEVIN_PROMPT_TIMEOUT_MS = 600_000;

interface DevinSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  currentModelId: string | undefined;
  protocolMap: Map<string, string>;
  activeItemId: string | undefined;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

export interface DevinAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

export function makeDevinAdapter(devinSettings: DevinSettings, options?: DevinAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("devin");
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;

    const sessions = new Map<ThreadId, DevinSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Devin runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Devin ACP callback.",
              cause,
            }),
        ),
      );

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        ctx.stopped = true;
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...stamp,
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: {},
        });
      });

    const handleParsedEvent = (ctx: DevinSessionContext, event: AcpParsedSessionEvent) =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const turnId = ctx.activeTurnId;
        switch (event._tag) {
          case "ModeChanged":
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: { state: "ready", reason: `Mode ${event.modeId}` },
            });
            return;
          case "AssistantItemStarted":
            ctx.activeItemId = event.itemId;
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: event.itemId,
                lifecycle: "item.started",
              }),
            );
            return;
          case "AssistantItemCompleted":
            ctx.activeItemId = undefined;
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                itemId: event.itemId,
                lifecycle: "item.completed",
              }),
            );
            return;
          case "ContentDelta":
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                ...(event.itemId ? { itemId: event.itemId } : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ToolCallUpdated":
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "PlanUpdated":
            yield* offerRuntimeEvent(
              makeAcpPlanUpdatedEvent({
                stamp,
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ConfigOptionsChanged":
          case "AvailableCommandsChanged":
            return;
        }
      });

    const startSession = (input: ProviderSessionStartInput) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const resolvedConfigPath = devinSettings.configPath.trim()
            ? path.resolve(expandHomePath(devinSettings.configPath))
            : undefined;

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const acp = yield* makeDevinAcpRuntime({
            devinSettings: {
              binaryPath: devinSettings.binaryPath,
              agentType: devinSettings.agentType,
              sandbox: devinSettings.sandbox,
              respectWorkspaceTrust: devinSettings.respectWorkspaceTrust,
              launchArgs: devinSettings.launchArgs,
              resolvedConfigPath,
            },
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            clientInfo: { name: "t3-code", version: "0.0.0" },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          yield* acp.handleRequestPermission((request) =>
            mapAcpCallbackFailure(
              Effect.sync(() => {
                const option = request.options[0];
                if (!option) {
                  return { outcome: { outcome: "cancelled" as const } };
                }
                return {
                  outcome: {
                    outcome: "selected" as const,
                    optionId: option.optionId,
                  },
                };
              }),
            ),
          );

          yield* acp.handleElicitation(() =>
            mapAcpCallbackFailure(Effect.succeed({ action: { action: "decline" as const } })),
          );

          const started = yield* acp.start().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const modelState = started.sessionSetupResult.models;
          const { protocolMap } = buildDevinModelsFromSessionModelState(modelState);
          let currentModelId = currentDevinModelIdFromSessionSetup(started.sessionSetupResult);

          const initialModelId = resolveDevinAcpBaseModelId(devinModelSelection?.model);
          const initialReasoningEffort = getModelSelectionStringOptionValue(
            devinModelSelection,
            "reasoningEffort",
          );

          if (
            initialModelId !== DEVIN_DEFAULT_MODEL_SLUG_PUBLIC ||
            initialReasoningEffort !== undefined
          ) {
            const next = yield* applyDevinAcpModelSelection({
              runtime: acp,
              protocolMap,
              currentModelId,
              requestedModelId: initialModelId,
              requestedReasoningEffort: initialReasoningEffort,
              mapError: (context) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: context.step,
                  detail: context.cause.message,
                  cause: context.cause,
                }),
            });
            currentModelId = next;
          }

          const modeState = started.sessionSetupResult.modes ?? (yield* acp.getModeState);
          const desiredMode = resolveDevinAcpMode(
            input.runtimeMode,
            modeState?.availableModes,
            "default",
          );
          if (desiredMode) {
            yield* acp.setMode(desiredMode).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/set_config_option",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }

          const createdAt = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: input.cwd,
            model: devinModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: input.resumeCursor,
            activeTurnId: undefined,
            createdAt,
            updatedAt: createdAt,
          };

          const ctx: DevinSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            currentModelId,
            protocolMap,
            activeItemId: undefined,
            activeTurnId: undefined,
            turns: [],
            stopped: false,
          };

          const nf = yield* Stream.runForEach(acp.getEvents(), (event) =>
            event._tag === "EventStreamBarrier" ? Effect.void : handleParsedEvent(ctx, event),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Devin runtime notification.", { cause }),
            ),
            Effect.forkIn(sessionScope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.started",
            ...stamp,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...stamp,
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready" },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const getSession = (threadId: ThreadId, _operation: string) => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const sendTurn = (input: ProviderSendTurnInput) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(input.threadId, "sendTurn");

          if (!input.input?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "input is required and must be non-empty.",
            });
          }

          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;

          const devinModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;

          if (devinModelSelection) {
            const requestedModelId = resolveDevinAcpBaseModelId(devinModelSelection.model);
            const requestedReasoningEffort = getModelSelectionStringOptionValue(
              devinModelSelection,
              "reasoningEffort",
            );
            const next = yield* applyDevinAcpModelSelection({
              runtime: ctx.acp,
              protocolMap: ctx.protocolMap,
              currentModelId: ctx.currentModelId,
              requestedModelId,
              requestedReasoningEffort,
              mapError: (context) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: context.step,
                  detail: context.cause.message,
                  cause: context.cause,
                }),
            });
            ctx.currentModelId = next;
          }

          const modeState = yield* ctx.acp.getModeState;
          const desiredMode = resolveDevinAcpMode(
            ctx.session.runtimeMode,
            modeState?.availableModes,
            input.interactionMode === "plan" ? "plan" : "default",
          );
          if (desiredMode) {
            yield* ctx.acp.setMode(desiredMode).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/set_config_option",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
          }

          const stamp = yield* makeEventStamp();
          ctx.session = { ...ctx.session, status: "running", activeTurnId: turnId };
          ctx.turns.push({ id: turnId, items: [] });

          const prompt: Array<{ type: "text"; text: string }> = [
            { type: "text", text: input.input.trim() },
          ];

          yield* offerRuntimeEvent({
            type: "turn.started",
            ...stamp,
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model: ctx.currentModelId },
          });

          const promptFiber = yield* ctx.acp.prompt({ prompt }).pipe(
            Effect.timeoutOption(DEVIN_PROMPT_TIMEOUT_MS),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
            Effect.forkIn(ctx.scope),
          );

          yield* Effect.gen(function* () {
            const promptResult = yield* Fiber.join(promptFiber).pipe(Effect.result);
            const stamp2 = yield* makeEventStamp();
            if (Result.isSuccess(promptResult)) {
              yield* Option.match(promptResult.success, {
                onNone: () =>
                  offerRuntimeEvent({
                    type: "turn.completed",
                    ...stamp2,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { state: "failed" },
                  }),
                onSome: (response) => {
                  const isCancelled = response.stopReason === "cancelled";
                  return offerRuntimeEvent({
                    type: "turn.completed",
                    ...stamp2,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {
                      state: isCancelled ? "cancelled" : "completed",
                      ...(response.stopReason ? { stopReason: response.stopReason } : {}),
                    },
                  });
                },
              });
            } else {
              const error = promptResult.failure;
              const message = error.message;
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...stamp2,
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: message,
                },
              });
            }
            if (ctx.activeTurnId === turnId) {
              ctx.activeTurnId = undefined;
            }
            ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined };
          }).pipe(Effect.forkIn(ctx.scope));

          return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
        }),
      );

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "interruptTurn");
          if (turnId !== undefined && ctx.activeTurnId !== turnId) {
            return;
          }
          if (ctx.activeTurnId === undefined) {
            return;
          }
          yield* ctx.acp.cancel.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/cancel",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          ctx.activeTurnId = undefined;
          ctx.session = { ...ctx.session, status: "ready", activeTurnId: undefined };
        }),
      );

    const respondToRequest = (
      threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "respondToRequest");
          void ctx;
          void _requestId;
          void _decision;
        }),
      );

    const respondToUserInput = (
      threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "respondToUserInput");
          void ctx;
          void _requestId;
          void _answers;
        }),
      );

    const stopSession = (threadId: ThreadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* getSession(threadId, "stopSession");
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values()).map((ctx) => ctx.session));

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(threadId, "readThread");
        return {
          threadId,
          turns: ctx.turns,
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread = (threadId: ThreadId, numTurns: number) =>
      Effect.gen(function* () {
        const ctx = yield* getSession(threadId, "rollbackThread");
        if (numTurns <= 0) {
          return { threadId, turns: ctx.turns } satisfies ProviderThreadSnapshot;
        }
        if (numTurns > ctx.turns.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Cannot roll back ${numTurns} turns; only ${ctx.turns.length} turns exist.`,
          });
        }
        ctx.turns = ctx.turns.slice(0, ctx.turns.length - numTurns);
        return { threadId, turns: ctx.turns } satisfies ProviderThreadSnapshot;
      });

    const stopAll = () =>
      Effect.gen(function* () {
        for (const ctx of Array.from(sessions.values())) {
          if (!ctx.stopped) {
            yield* stopSessionInternal(ctx);
          }
        }
      });

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies DevinAdapterShape;
  });
}
