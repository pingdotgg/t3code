import {
  ApprovalRequestId,
  type OmpSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  OMP_RESUME_VERSION,
  applyOmpRequestedSessionConfiguration,
  buildOmpElicitationContent,
  makeOmpAcpRuntime,
  getOmpAcpCurrentModel,
  resolveEmptyOmpElicitationResponse,
  ompElicitationQuestions,
  parseOmpResume,
  selectAutoApprovedOmpPermissionOption,
  selectOmpPermissionOptionId,
  shouldAutoApproveOmpPermission,
} from "../acp/OmpAcpSupport.ts";
import { type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("omp");

function mapOmpAcpToAdapterError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: "Oh My Pi ACP request failed.",
    cause,
  });
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface OmpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Overrides construction settings when a session starts. */
  readonly resolveSettings?: Effect.Effect<OmpSettings>;
  readonly makeEventStamp?: () => Effect.Effect<{
    readonly eventId: EventId;
    readonly createdAt: string;
  }>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  defaultModel: string | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  exitFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turnInProgress: boolean;
  promptInFlight: boolean;
  stopRequested: boolean;
  interruptPending: boolean;
  readonly interruptedTurnIds: Set<TurnId>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

interface ThreadLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const adapterScope = yield* Scope.Scope;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, ThreadLockEntry>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OMP runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp =
      options?.makeEventStamp ?? (() => Effect.all({ eventId: nextEventId, createdAt: nowIso }));
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process an OMP ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const retainThreadLock = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) {
          const next = new Map(current);
          next.set(threadId, { ...existing, users: existing.users + 1 });
          return Effect.succeed([existing.semaphore, next] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, { semaphore, users: 1 });
            return [semaphore, next] as const;
          }),
        );
      });

    const releaseThreadLock = (threadId: string) =>
      SynchronizedRef.update(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (!existing) return current;
        const next = new Map(current);
        if (existing.users === 1) next.delete(threadId);
        else next.set(threadId, { ...existing, users: existing.users - 1 });
        return next;
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(retainThreadLock(threadId), (semaphore) =>
        semaphore.withPermit(effect).pipe(Effect.ensuring(releaseThreadLock(threadId))),
      );

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
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
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logError("Failed to write an OMP native notification log.", {
                cause: Cause.pretty(cause),
                method,
                threadId,
              }),
        ),
      );

    const emitPlanUpdate = (
      ctx: OmpSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OmpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const hasInterruptibleWork = (ctx: OmpSessionContext) =>
      ctx.turnInProgress ||
      ctx.activeTurnId !== undefined ||
      ctx.session.activeTurnId !== undefined ||
      ctx.pendingApprovals.size > 0 ||
      ctx.pendingUserInputs.size > 0;

    const stopSessionInternal = (ctx: OmpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        if (ctx.exitFiber) {
          yield* Fiber.interrupt(ctx.exitFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        if (sessions.get(ctx.threadId) !== ctx) return;
        sessions.delete(ctx.threadId);
        yield* makeEventStamp().pipe(
          Effect.flatMap((stamp) =>
            offerRuntimeEvent({
              type: "session.exited",
              ...stamp,
              provider: PROVIDER,
              threadId: ctx.threadId,
              payload: { exitKind: "graceful" },
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logError("Failed to publish graceful OMP session exit.", {
                  cause: Cause.pretty(cause),
                  threadId: ctx.threadId,
                }),
          ),
        );
      });

    const handleUnexpectedExit = (ctx: OmpSessionContext, reason: string) =>
      Effect.gen(function* () {
        if (ctx.stopped || sessions.get(ctx.threadId) !== ctx) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
        if (sessions.get(ctx.threadId) === ctx) sessions.delete(ctx.threadId);
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        const { activeTurnId: _activeTurnId, ...inactiveSession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.session = {
          ...inactiveSession,
          status: "error",
          updatedAt: yield* nowIso,
        };
        if (activeTurnId) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: activeTurnId,
            payload: { state: "failed", errorMessage: reason },
          });
        }
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { state: "error", reason },
        });
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { reason, recoverable: false, exitKind: "error" },
        });
      }).pipe(Effect.ensuring(Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore)));

    const startSession: OmpAdapterShape["startSession"] = (input) => {
      let stopReservation: OmpSessionContext | undefined;
      return Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
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

        const activeSession = sessions.get(input.threadId);
        if (activeSession && !activeSession.stopped) {
          stopReservation = activeSession;
          activeSession.stopRequested = true;
          if (hasInterruptibleWork(activeSession)) {
            yield* stopSessionInternal(activeSession);
          }
        }

        return yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ompModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const existing = sessions.get(input.threadId);
            if (existing && !existing.stopped) {
              yield* stopSessionInternal(existing);
            }

            const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
            const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
            const sessionScope = yield* Scope.make("sequential");
            let sessionScopeTransferred = false;
            let startupContext: OmpSessionContext | undefined;
            yield* Effect.addFinalizer(() => {
              if (sessionScopeTransferred) return Effect.void;
              return startupContext
                ? stopSessionInternal(startupContext).pipe(Effect.ignore)
                : Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            });
            let ctx!: OmpSessionContext;

            const resumeSessionId = parseOmpResume(input.resumeCursor)?.sessionId;
            const acpNativeLoggers = makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            });

            const effectiveOmpSettings = options?.resolveSettings
              ? yield* options.resolveSettings
              : ompSettings;

            const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
            const acp = yield* makeOmpAcpRuntime({
              ompSettings: effectiveOmpSettings,
              ...(options?.environment ? { environment: options.environment } : {}),
              childProcessSpawner,
              cwd,
              runtimeMode: input.runtimeMode,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientInfo: { name: "t3-code", version: "0.0.0" },
              ...(mcpSession
                ? {
                    mcpServers: [
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
                    ],
                  }
                : {}),
              ...acpNativeLoggers,
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Failed to create the Oh My Pi ACP runtime.",
                    cause,
                  }),
              ),
            );
            const started = yield* Effect.gen(function* () {
              yield* acp.handleElicitation((params) =>
                mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, "session/elicitation", params, "acp.jsonrpc");
                    if (params.mode !== "form") {
                      return { action: { action: "cancel" as const } };
                    }
                    const questions = ompElicitationQuestions(params);
                    if (questions.length === 0) {
                      return resolveEmptyOmpElicitationResponse(params);
                    }
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                    pendingUserInputs.set(requestId, { answers });
                    yield* offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      payload: { questions: questions.map((entry) => entry.question) },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/elicitation",
                        payload: params,
                      },
                    });
                    const resolved = yield* Deferred.await(answers);
                    pendingUserInputs.delete(requestId);
                    yield* offerRuntimeEvent({
                      type: "user-input.resolved",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      payload: { answers: resolved },
                    });
                    const content = buildOmpElicitationContent(questions, resolved);
                    const isMissingRequiredAnswer = questions.some(
                      (question) =>
                        question.required &&
                        !Object.hasOwn(content, question.key) &&
                        !(question.otherKey && Object.hasOwn(content, question.otherKey)),
                    );
                    if (isMissingRequiredAnswer) {
                      return { action: { action: "cancel" as const } };
                    }
                    return { action: { action: "accept" as const, content } };
                  }),
                ),
              );
              yield* acp.handleRequestPermission((params) =>
                mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    yield* logNative(
                      input.threadId,
                      "session/request_permission",
                      params,
                      "acp.jsonrpc",
                    );
                    const permissionRequest = parsePermissionRequest(params);
                    if (shouldAutoApproveOmpPermission(input.runtimeMode, permissionRequest)) {
                      const autoApprovedOptionId = selectAutoApprovedOmpPermissionOption(params);
                      if (autoApprovedOptionId !== undefined) {
                        return {
                          outcome: {
                            outcome: "selected" as const,
                            optionId: autoApprovedOptionId,
                          },
                        };
                      }
                    }
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const decision = yield* Deferred.make<ProviderApprovalDecision>();
                    pendingApprovals.set(requestId, { decision });
                    yield* offerRuntimeEvent(
                      makeAcpRequestOpenedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        requestId: runtimeRequestId,
                        permissionRequest,
                        detail:
                          permissionRequest.detail ??
                          encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                          "[unserializable params]",
                        args: params,
                        source: "acp.jsonrpc",
                        method: "session/request_permission",
                        rawPayload: params,
                      }),
                    );
                    const resolved = yield* Deferred.await(decision);
                    pendingApprovals.delete(requestId);
                    yield* offerRuntimeEvent(
                      makeAcpRequestResolvedEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        requestId: runtimeRequestId,
                        permissionRequest,
                        decision: resolved,
                      }),
                    );
                    if (resolved === "cancel") {
                      return { outcome: { outcome: "cancelled" as const } };
                    }
                    const optionId = selectOmpPermissionOptionId(params, resolved);
                    return {
                      outcome: optionId
                        ? { outcome: "selected" as const, optionId }
                        : { outcome: "cancelled" as const },
                    };
                  }),
                ),
              );
              return yield* acp.start();
            }).pipe(Effect.mapError((error) => mapOmpAcpToAdapterError("session/start", error)));

            const defaultModel = getOmpAcpCurrentModel(yield* acp.getConfigOptions);

            yield* applyOmpRequestedSessionConfiguration({
              runtime: acp,
              modelSelection: ompModelSelection,
              defaultModel,
              mapError: ({ cause, method }) => mapOmpAcpToAdapterError(method, cause),
            });

            const now = yield* nowIso;
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd,
              model: ompModelSelection?.model,
              threadId: input.threadId,
              resumeCursor: {
                schemaVersion: OMP_RESUME_VERSION,
                sessionId: started.sessionId,
              },
              createdAt: now,
              updatedAt: now,
            };

            ctx = {
              threadId: input.threadId,
              stopRequested: false,
              session,
              scope: sessionScope,
              acp,
              defaultModel,
              notificationFiber: undefined,
              exitFiber: undefined,
              pendingApprovals,
              pendingUserInputs,
              turnInProgress: false,
              promptInFlight: false,
              interruptPending: false,
              interruptedTurnIds: new Set(),
              turns: [],
              lastPlanFingerprint: undefined,
              activeTurnId: undefined,
              stopped: false,
            };
            startupContext = ctx;

            const nf = yield* Stream.runDrain(
              Stream.mapEffect(acp.getEvents(), (event) =>
                Effect.gen(function* () {
                  switch (event._tag) {
                    case "EventStreamBarrier":
                      yield* Deferred.succeed(event.acknowledge, undefined);
                      return;
                    case "ModeChanged":
                      return;
                    case "UsageUpdated":
                      yield* offerRuntimeEvent({
                        type: "thread.token-usage.updated",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        payload: {
                          usage: {
                            usedTokens: event.payload.used,
                            ...(event.payload.size > 0 ? { maxTokens: event.payload.size } : {}),
                          },
                        },
                        raw: {
                          source: "acp.jsonrpc",
                          method: "session/update",
                          payload: event.rawPayload,
                        },
                      });
                      return;
                    case "AssistantItemStarted":
                      yield* offerRuntimeEvent(
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: ctx.activeTurnId,
                          itemId: event.itemId,
                          lifecycle: "item.started",
                        }),
                      );
                      return;
                    case "AssistantItemCompleted":
                      yield* offerRuntimeEvent(
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: ctx.activeTurnId,
                          itemId: event.itemId,
                          lifecycle: "item.completed",
                        }),
                      );
                      return;
                    case "PlanUpdated":
                      yield* logNative(
                        ctx.threadId,
                        "session/update",
                        event.rawPayload,
                        "acp.jsonrpc",
                      );
                      yield* emitPlanUpdate(
                        ctx,
                        event.payload,
                        event.rawPayload,
                        "acp.jsonrpc",
                        "session/update",
                      );
                      return;
                    case "ToolCallUpdated":
                      yield* logNative(
                        ctx.threadId,
                        "session/update",
                        event.rawPayload,
                        "acp.jsonrpc",
                      );
                      yield* offerRuntimeEvent(
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: ctx.activeTurnId,
                          toolCall: event.toolCall,
                          rawPayload: event.rawPayload,
                        }),
                      );
                      return;
                    case "ContentDelta":
                      yield* logNative(
                        ctx.threadId,
                        "session/update",
                        event.rawPayload,
                        "acp.jsonrpc",
                      );
                      yield* offerRuntimeEvent(
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: ctx.activeTurnId,
                          ...(event.itemId ? { itemId: event.itemId } : {}),
                          text: event.text,
                          rawPayload: event.rawPayload,
                        }),
                      );
                      return;
                  }
                }).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.interrupt
                      : Effect.logError("Failed to process an OMP runtime notification.", {
                          cause: Cause.pretty(cause),
                        }),
                  ),
                ),
              ),
            ).pipe(Effect.forkIn(ctx.scope));

            ctx.notificationFiber = nf;
            sessions.set(input.threadId, ctx);
            const exitFiber = yield* acp.awaitExit.pipe(
              Effect.flatMap((exitCode) =>
                withThreadLock(
                  ctx.threadId,
                  handleUnexpectedExit(ctx, `OMP ACP process exited with code ${exitCode}.`),
                ),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.gen(function* () {
                      yield* Effect.logError("Failed to observe OMP ACP process exit.", {
                        cause: Cause.pretty(cause),
                        threadId: ctx.threadId,
                      });
                      yield* withThreadLock(
                        ctx.threadId,
                        handleUnexpectedExit(ctx, "Failed to observe OMP ACP process exit."),
                      );
                    }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.logError("Failed to settle an exited OMP ACP process.", {
                      cause: Cause.pretty(cause),
                    }),
              ),
              Effect.forkIn(adapterScope),
            );
            ctx.exitFiber = exitFiber;

            yield* offerRuntimeEvent({
              type: "session.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* offerRuntimeEvent({
              type: "session.state.changed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { state: "ready", reason: "OMP ACP session ready" },
            });
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });
            sessionScopeTransferred = true;

            return session;
          }).pipe(Effect.scoped),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (
              stopReservation &&
              sessions.get(input.threadId) === stopReservation &&
              !stopReservation.stopped
            ) {
              stopReservation.stopRequested = false;
            }
          }),
        ),
      );
    };

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) => {
      let turnContext: OmpSessionContext | undefined;
      return withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          turnContext = ctx;
          ctx.turnInProgress = true;
          if (ctx.interruptPending) {
            ctx.interruptPending = false;
            return yield* Effect.interrupt;
          }
          if (ctx.stopRequested) {
            return yield* Effect.interrupt;
          }
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            promptParts.push({ type: "text", text: input.input.trim() });
          }
          for (const attachment of input.attachments ?? []) {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Failed to read attachment '${attachment.id}'.`,
                    cause,
                  }),
              ),
            );
            promptParts.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          if (
            ctx.defaultModel === undefined &&
            ctx.session.model === "default" &&
            model !== "default"
          ) {
            ctx.defaultModel = getOmpAcpCurrentModel(yield* ctx.acp.getConfigOptions);
          }
          yield* applyOmpRequestedSessionConfiguration({
            runtime: ctx.acp,
            ...(input.interactionMode
              ? {
                  interactionMode:
                    input.interactionMode === "plan" ? "default" : input.interactionMode,
                }
              : {}),
            modelSelection:
              model === undefined ? undefined : { model, options: turnModelSelection?.options },
            defaultModel: ctx.defaultModel,
            mapError: ({ cause, method }) => mapOmpAcpToAdapterError(method, cause),
          });

          const turnId = TurnId.make(yield* randomUUIDv4);
          const turnStartedStamp = yield* makeEventStamp();
          if (ctx.stopped) {
            return yield* Effect.interrupt;
          }
          if (ctx.interruptPending) {
            ctx.interruptPending = false;
            return yield* Effect.interrupt;
          }
          const resetOwnedActiveTurn = Effect.gen(function* () {
            if (ctx.stopped || ctx.activeTurnId !== turnId || ctx.session.activeTurnId !== turnId) {
              return false;
            }
            const { activeTurnId: _activeTurnId, ...inactiveSession } = ctx.session;
            ctx.activeTurnId = undefined;
            ctx.session = {
              ...inactiveSession,
              status: "ready",
              updatedAt: yield* nowIso,
            };
            ctx.turnInProgress = false;
            ctx.interruptPending = false;
            return true;
          });
          ctx.activeTurnId = turnId;
          ctx.lastPlanFingerprint = undefined;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          const turnStartedExit = yield* offerRuntimeEvent({
            type: "turn.started",
            ...turnStartedStamp,
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { model },
          }).pipe(Effect.exit);
          if (Exit.isFailure(turnStartedExit)) {
            yield* resetOwnedActiveTurn;
            return yield* Effect.failCause(turnStartedExit.cause);
          }
          if (ctx.stopped) {
            return yield* Effect.interrupt;
          }
          if (ctx.interruptPending || ctx.interruptedTurnIds.delete(turnId)) {
            ctx.interruptPending = false;
            if (yield* resetOwnedActiveTurn) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state: "cancelled", stopReason: "cancelled" },
              }).pipe(Effect.ignore);
            }
            return yield* Effect.interrupt;
          }

          ctx.promptInFlight = true;
          const promptExit = yield* ctx.acp.prompt({ prompt: promptParts }).pipe(
            Effect.mapError((error) => mapOmpAcpToAdapterError("session/prompt", error)),
            Effect.exit,
          );
          ctx.promptInFlight = false;
          yield* ctx.acp.clearPendingCancel;
          if (Exit.isFailure(promptExit)) {
            if (ctx.stopped) {
              return yield* Effect.interrupt;
            }
            ctx.interruptedTurnIds.delete(turnId);
            yield* Effect.logError("Oh My Pi ACP prompt failed.", {
              cause: Cause.pretty(promptExit.cause),
              threadId: input.threadId,
            });
            if (yield* resetOwnedActiveTurn) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: "Oh My Pi ACP prompt failed.",
                },
              });
            }
            return yield* Effect.failCause(promptExit.cause);
          }

          const result = promptExit.value;
          if (ctx.stopped) {
            return yield* Effect.interrupt;
          }
          if (ctx.activeTurnId !== turnId || ctx.session.activeTurnId !== turnId) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Oh My Pi ACP exited before the turn settled.",
            });
          }
          ctx.interruptedTurnIds.delete(turnId);
          ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          const { activeTurnId: _activeTurnId, ...inactiveSession } = ctx.session;
          ctx.activeTurnId = undefined;
          ctx.session = {
            ...inactiveSession,
            status: "ready",
            updatedAt: yield* nowIso,
            model,
          };
          ctx.turnInProgress = false;
          ctx.interruptPending = false;
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
            },
          });
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      ).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!turnContext) return;
            turnContext.turnInProgress = false;
            turnContext.promptInFlight = false;
            turnContext.interruptPending = false;
            yield* turnContext.acp.clearPendingCancel;
          }),
        ),
      );
    };

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        if (turnId !== undefined && activeTurnId !== turnId) return;
        if (activeTurnId !== undefined) {
          ctx.interruptedTurnIds.add(activeTurnId);
        } else if (ctx.turnInProgress) {
          ctx.interruptPending = true;
        } else {
          return;
        }
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.promptInFlight) {
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) => mapOmpAcpToAdapterError("session/cancel", error)),
            ),
          );
        }
      });

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Oh My Pi ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) => {
      let stopReservation: OmpSessionContext | undefined;
      return Effect.gen(function* () {
        const activeSession = sessions.get(threadId);
        if (activeSession && !activeSession.stopped) {
          stopReservation = activeSession;
          activeSession.stopRequested = true;
          if (hasInterruptibleWork(activeSession)) {
            yield* stopSessionInternal(activeSession);
            return;
          }
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            yield* stopSessionInternal(ctx);
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (
              stopReservation &&
              sessions.get(threadId) === stopReservation &&
              !stopReservation.stopped
            ) {
              stopReservation.stopRequested = false;
            }
          }),
        ),
      );
    };

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
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
    } satisfies OmpAdapterShape;
  });
}
