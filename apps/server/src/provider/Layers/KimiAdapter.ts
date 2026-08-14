/**
 * KimiAdapterLive - Kimi Code (`kimi acp`) sessions via the standard ACP runtime.
 *
 * @module KimiAdapterLive
 */
import {
  ApprovalRequestId,
  type KimiSettings,
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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
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
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { applyKimiAcpModelSelection, makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";
import { parsePermissionRequest, type AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import {
  extractKimiPermissionQuestions,
  resolveKimiQuestionPermissionOption,
} from "../acp/KimiUserInput.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  getKimiCliCompatibilityIssue,
  parseKimiCliVersion,
  runKimiVersionCommand,
} from "../Drivers/KimiVersion.ts";
import type { KimiAdapterShape } from "../Services/KimiAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kimi");
const KIMI_RESUME_VERSION = 1 as const;
const KimiResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(KIMI_RESUME_VERSION),
  sessionId: Schema.String,
});
const isKimiResumeCursor = Schema.is(KimiResumeCursor);

export interface KimiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly request: EffectAcpSchema.RequestPermissionRequest;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ThreadLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
}

interface KimiSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  readonly interruptedTurnIds: Set<TurnId>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly stoppedSignal: Deferred.Deferred<void>;
  readonly turnCompletionLock: Semaphore.Semaphore;
  readonly supportsImages: boolean;
  stopped: boolean;
}

function parseKimiResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (!isKimiResumeCursor(raw) || !raw.sessionId.trim()) {
    return undefined;
  }
  return { sessionId: raw.sessionId.trim() };
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const option = request.options.find(
    (candidate) => candidate.kind === "allow_always" || candidate.kind === "allow_once",
  );
  return option?.optionId.trim() || undefined;
}

function permissionOptionIdForDecision(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : decision === "decline"
          ? "reject_once"
          : undefined;
  if (!kind) return undefined;
  return request.options.find((option) => option.kind === kind)?.optionId.trim() || undefined;
}

function findKimiMode(
  modeState: AcpSessionModeState | undefined,
  aliases: ReadonlyArray<string>,
): string | undefined {
  if (!modeState) return undefined;
  for (const alias of aliases) {
    const normalized = alias.toLowerCase();
    const mode = modeState.availableModes.find(
      (entry) => entry.id.toLowerCase() === normalized || entry.name.toLowerCase() === normalized,
    );
    if (mode) return mode.id;
  }
  return undefined;
}

function requestedKimiModeId(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode: "default" | "plan" | undefined;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  if (input.interactionMode === "plan") {
    return findKimiMode(input.modeState, ["plan", "architect"]);
  }
  if (input.runtimeMode === "auto") {
    return (
      findKimiMode(input.modeState, ["auto"]) ?? findKimiMode(input.modeState, ["default", "ask"])
    );
  }
  if (input.runtimeMode === "full-access") {
    return (
      findKimiMode(input.modeState, ["yolo", "code"]) ??
      findKimiMode(input.modeState, ["default", "ask"])
    );
  }
  return findKimiMode(input.modeState, ["default", "ask"]);
}

function initializedPromptSupportsImages(
  initializeResult: EffectAcpSchema.InitializeResponse,
): boolean {
  return initializeResult.agentCapabilities?.promptCapabilities?.image === true;
}

export function makeKimiAdapter(kimiSettings: KimiSettings, options?: KimiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kimi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const adapterScope = yield* Scope.Scope;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const sessions = new Map<ThreadId, KimiSessionContext>();
    const threadLocks = yield* SynchronizedRef.make(new Map<string, ThreadLockEntry>());
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const ensureSupportedKimiVersion = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const probeResult = yield* runKimiVersionCommand(kimiSettings, options?.environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.timeoutOption(Duration.seconds(4)),
          Effect.result,
        );
        if (Result.isFailure(probeResult)) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Failed to verify the Kimi CLI version before starting ACP.",
            cause: probeResult.failure,
          });
        }
        if (Option.isNone(probeResult.success)) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Kimi CLI version check timed out after 4 seconds.",
          });
        }
        const probe = probeResult.success.value;
        if (probe.code !== 0) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: `Kimi CLI version check exited with code ${probe.code}.`,
          });
        }
        const version = parseKimiCliVersion(`${probe.stdout}\n${probe.stderr}`);
        const compatibilityIssue = getKimiCliCompatibilityIssue(version);
        if (compatibilityIssue !== null) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: compatibilityIssue,
          });
        }
      });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Kimi runtime identifier.",
            cause,
          }),
      ),
    );
    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Kimi ACP callback.",
              cause,
            }),
        ),
      );
    const nextEventStamp = () =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: nowIso,
      });

    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
    const completeTurn = (input: {
      readonly context: KimiSessionContext;
      readonly turnId: TurnId;
      readonly state: "cancelled" | "completed" | "failed";
      readonly stopReason: string | null;
      readonly finalizeSession: boolean;
      readonly model?: string;
    }) =>
      input.context.turnCompletionLock.withPermit(
        Effect.gen(function* () {
          if (input.context.activeTurnId !== input.turnId || input.context.stopped) {
            return false;
          }
          const updatedAt = yield* nowIso;
          if (input.context.activeTurnId !== input.turnId || input.context.stopped) {
            return false;
          }
          input.context.activeTurnId = undefined;
          if (input.finalizeSession) {
            input.context.session = {
              ...input.context.session,
              status: "ready",
              activeTurnId: undefined,
              updatedAt,
              ...(input.model ? { model: input.model } : {}),
            };
          }
          yield* publish({
            type: "turn.completed",
            ...(yield* nextEventStamp()),
            provider: PROVIDER,
            threadId: input.context.threadId,
            turnId: input.turnId,
            payload: { state: input.state, stopReason: input.stopReason },
          });
          return true;
        }),
      );
    const getThreadLock = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocks, (current) => {
        const existing = current.get(threadId);
        if (existing) {
          return Effect.succeed([
            existing.semaphore,
            new Map(current).set(threadId, { ...existing, users: existing.users + 1 }),
          ] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map(
            (semaphore) =>
              [semaphore, new Map(current).set(threadId, { semaphore, users: 1 })] as const,
          ),
        );
      });
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadLock(threadId), (lock) =>
        lock.withPermit(effect).pipe(
          Effect.ensuring(
            SynchronizedRef.update(threadLocks, (current) => {
              const entry = current.get(threadId);
              if (entry?.semaphore !== lock) return current;
              const next = new Map(current);
              if (entry.users === 1) next.delete(threadId);
              else next.set(threadId, { ...entry, users: entry.users - 1 });
              return next;
            }),
          ),
        ),
      );
    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };
    const settleApprovals = (pending: ReadonlyMap<ApprovalRequestId, PendingApproval>) =>
      Effect.forEach(
        pending.values(),
        (approval) => Deferred.succeed(approval.decision, "cancel").pipe(Effect.ignore),
        { discard: true },
      );
    const settleUserInputs = (pending: ReadonlyMap<ApprovalRequestId, PendingUserInput>) =>
      Effect.forEach(
        pending.values(),
        (input) => Deferred.succeed(input.answers, {}).pipe(Effect.ignore),
        { discard: true },
      );
    const applyKimiMode = (input: {
      readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly interactionMode: "default" | "plan" | undefined;
      readonly threadId: ThreadId;
    }) =>
      Effect.gen(function* () {
        const modeId = requestedKimiModeId({
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          modeState: yield* input.runtime.getModeState,
        });
        if (modeId) yield* input.runtime.setMode(modeId);
      }).pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_mode", cause),
        ),
      );

    const stopSessionInternal = (
      context: KimiSessionContext,
      options?: {
        readonly clearMcp?: boolean;
        readonly exitKind?: "graceful" | "error";
        readonly reason?: string;
      },
    ) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        yield* Deferred.succeed(context.stoppedSignal, undefined);
        yield* context.turnCompletionLock.withPermit(
          Effect.gen(function* () {
            const activeTurnId = context.activeTurnId;
            if (activeTurnId === undefined) return;
            context.activeTurnId = undefined;
            yield* publish({
              type: "turn.completed",
              ...(yield* nextEventStamp()),
              provider: PROVIDER,
              threadId: context.threadId,
              turnId: activeTurnId,
              payload: {
                state: options?.exitKind === "error" ? "failed" : "cancelled",
                stopReason: null,
              },
            });
          }),
        );
        yield* settleApprovals(context.pendingApprovals);
        yield* settleUserInputs(context.pendingUserInputs);
        if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
        yield* Effect.ignore(context.acp.cancel);
        yield* Effect.ignore(Scope.close(context.scope, Exit.void));
        sessions.delete(context.threadId);
        if (options?.clearMcp !== false)
          McpProviderSession.clearMcpProviderSession(context.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* nextEventStamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: {
            exitKind: options?.exitKind ?? "graceful",
            ...(options?.reason ? { reason: options.reason } : {}),
          },
        });
      });

    const startSession: KimiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
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
          yield* ensureSupportedKimiVersion(input.threadId);
          const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
          const existing = sessions.get(input.threadId);
          if (existing) yield* stopSessionInternal(existing, { clearMcp: false });

          const scope = yield* Scope.make("sequential");
          let transferred = false;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(scope, Exit.void),
          );
          const cwd = path.resolve(input.cwd.trim());
          const resumeSessionId = parseKimiResume(input.resumeCursor)?.sessionId;
          const nativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger: options?.nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acp = yield* makeKimiAcpRuntime({
            kimiSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...nativeLoggers,
            ...(mcp
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcp.endpoint,
                      headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                    },
                  ],
                }
              : {}),
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start the Kimi ACP runtime.",
                  cause,
                }),
            ),
          );
          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          let context: KimiSessionContext | undefined;
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  const questions = extractKimiPermissionQuestions(params);
                  if (questions) {
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                    pendingUserInputs.set(requestId, { answers });
                    yield* publish({
                      type: "user-input.requested",
                      ...(yield* nextEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: context?.activeTurnId,
                      requestId: RuntimeRequestId.make(requestId),
                      payload: { questions },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/request_permission",
                        payload: params,
                      },
                    });
                    const resolved = yield* Deferred.await(answers);
                    pendingUserInputs.delete(requestId);
                    yield* publish({
                      type: "user-input.resolved",
                      ...(yield* nextEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: context?.activeTurnId,
                      requestId: RuntimeRequestId.make(requestId),
                      payload: { answers: resolved },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/request_permission",
                        payload: params,
                      },
                    });
                    const optionId = resolveKimiQuestionPermissionOption({
                      request: params,
                      questions,
                      answers: resolved,
                    });
                    return {
                      outcome: optionId
                        ? { outcome: "selected" as const, optionId }
                        : { outcome: "cancelled" as const },
                    };
                  }

                  const permission = parsePermissionRequest(params);
                  const autoAcceptEdit =
                    input.runtimeMode === "auto-accept-edits" &&
                    ["edit", "delete", "move"].includes(permission.kind);
                  if (input.runtimeMode === "full-access" || autoAcceptEdit) {
                    const optionId = selectAutoApprovedPermissionOption(params);
                    if (optionId) return { outcome: { outcome: "selected" as const, optionId } };
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, { decision, request: params });
                  yield* publish(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* nextEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: context?.activeTurnId,
                      requestId: RuntimeRequestId.make(requestId),
                      permissionRequest: permission,
                      detail: permission.detail ?? "Kimi ACP permission request",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* publish(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* nextEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: context?.activeTurnId,
                      requestId: RuntimeRequestId.make(requestId),
                      permissionRequest: permission,
                      decision: resolved,
                    }),
                  );
                  if (resolved === "cancel") return { outcome: { outcome: "cancelled" as const } };
                  const optionId = permissionOptionIdForDecision(params, resolved);
                  if (!optionId) {
                    return yield* new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/request_permission",
                      detail: `Kimi did not advertise an ACP option for '${resolved}'.`,
                      cause: params,
                    });
                  }
                  return { outcome: { outcome: "selected" as const, optionId } };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          yield* applyKimiAcpModelSelection({
            runtime: acp,
            model: modelSelection?.model,
            selections: modelSelection?.options,
          }).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
            ),
          );
          yield* applyKimiMode({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            threadId: input.threadId,
          });
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: KIMI_RESUME_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };
          context = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            scope,
            acp,
            session,
            activeTurnId: undefined,
            promptsInFlight: 0,
            interruptedTurnIds: new Set(),
            turns: [],
            pendingApprovals,
            pendingUserInputs,
            notificationFiber: undefined,
            stoppedSignal: yield* Deferred.make<void>(),
            turnCompletionLock: yield* Semaphore.make(1),
            supportsImages: initializedPromptSupportsImages(started.initializeResult),
            stopped: false,
          };
          const ownedContext = context;
          ownedContext.notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (ownedContext.stopped || sessions.get(ownedContext.threadId) !== ownedContext)
                  return;
                const eventInput = {
                  stamp: yield* nextEventStamp(),
                  provider: PROVIDER,
                  threadId: ownedContext.threadId,
                  turnId: ownedContext.activeTurnId,
                };
                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* publish(
                      makeAcpAssistantItemEvent({
                        ...eventInput,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* publish(
                      makeAcpAssistantItemEvent({
                        ...eventInput,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* publish(
                      makeAcpPlanUpdatedEvent({
                        ...eventInput,
                        payload: event.payload,
                        source: "acp.jsonrpc",
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* publish(
                      makeAcpToolCallEvent({
                        ...eventInput,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* publish(
                      makeAcpContentDeltaEvent({
                        ...eventInput,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  default:
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch(() => Effect.void),
            Effect.forkIn(ownedContext.scope),
          );
          sessions.set(input.threadId, ownedContext);
          transferred = true;
          yield* publish({
            type: "session.started",
            ...(yield* nextEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* publish({
            type: "session.state.changed",
            ...(yield* nextEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Kimi ACP session ready" },
          });
          yield* publish({
            type: "thread.started",
            ...(yield* nextEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* Effect.exit(acp.processExit).pipe(
            Effect.flatMap((processExit) => {
              if (ownedContext.stopped || sessions.get(ownedContext.threadId) !== ownedContext) {
                return Effect.void;
              }
              const reason = Exit.isSuccess(processExit)
                ? `Kimi ACP process exited with code ${processExit.value}.`
                : "Kimi ACP process exited unexpectedly.";
              return stopSessionInternal(ownedContext, { exitKind: "error", reason });
            }),
            Effect.catch(() => Effect.void),
            Effect.forkIn(adapterScope),
          );
          yield* Effect.yieldNow;
          if (ownedContext.stopped || sessions.get(input.threadId) !== ownedContext) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Kimi ACP process exited during session startup.",
            });
          }
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: KimiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const steeringTurnId = context.promptsInFlight > 0 ? context.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        context.promptsInFlight += 1;
        return yield* Effect.gen(function* () {
          const selection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = selection?.model ?? context.session.model;
          const prompt: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
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
            if (!context.supportsImages) {
              prompt.push({ type: "text", text: `Attachment available at: ${attachmentPath}` });
              continue;
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: "Failed to read the Kimi prompt attachment.",
                    cause,
                  }),
              ),
            );
            prompt.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          if (prompt.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          context.activeTurnId = turnId;
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          if (!steeringTurnId) {
            yield* publish({
              type: "turn.started",
              ...(yield* nextEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model },
            });
          }
          yield* applyKimiAcpModelSelection({
            runtime: context.acp,
            model,
            selections: selection?.options,
          }).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
            ),
          );
          yield* applyKimiMode({
            runtime: context.acp,
            runtimeMode: context.session.runtimeMode,
            interactionMode: input.interactionMode,
            threadId: input.threadId,
          });
          context.session = {
            ...context.session,
            updatedAt: yield* nowIso,
            model,
          };
          if (context.interruptedTurnIds.has(turnId)) {
            if (context.promptsInFlight === 1) {
              context.interruptedTurnIds.delete(turnId);
              yield* completeTurn({
                context,
                turnId,
                state: "cancelled",
                stopReason: null,
                finalizeSession: true,
              });
            }
            return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
          }
          const result = yield* context.acp
            .prompt({ prompt })
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
              ),
            );
          yield* Effect.raceFirst(context.acp.drainEvents, Deferred.await(context.stoppedSignal));
          if (
            sessions.get(input.threadId) !== context ||
            context.stopped ||
            context.activeTurnId !== turnId
          ) {
            return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
          }
          const record = context.turns.find((entry) => entry.id === turnId);
          if (record) record.items.push({ prompt, result });
          else context.turns.push({ id: turnId, items: [{ prompt, result }] });
          if (context.promptsInFlight === 1) {
            const interrupted = context.interruptedTurnIds.delete(turnId);
            yield* completeTurn({
              context,
              turnId,
              state: interrupted || result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
              finalizeSession: true,
              ...(model ? { model } : {}),
            });
          }
          return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
        }).pipe(
          Effect.onError(() =>
            (context.promptsInFlight === 1
              ? Effect.gen(function* () {
                  context.interruptedTurnIds.delete(turnId);
                  yield* completeTurn({
                    context,
                    turnId,
                    state: "failed",
                    stopReason: null,
                    finalizeSession: true,
                  });
                })
              : Effect.void
            ).pipe(Effect.ignore),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              context.promptsInFlight = Math.max(0, context.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: KimiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const activeTurnId = turnId ?? context.activeTurnId;
        if (activeTurnId) context.interruptedTurnIds.add(activeTurnId);
        yield* settleApprovals(context.pendingApprovals);
        yield* settleUserInputs(context.pendingUserInputs);
        yield* Effect.ignore(
          context.acp.cancel.pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", cause),
            ),
          ),
        );
      });
    const respondToRequest: KimiAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        if (decision !== "cancel" && !permissionOptionIdForDecision(pending.request, decision)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Kimi did not advertise an ACP option for '${decision}'.`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });
    const respondToUserInput: KimiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });
    const readThread: KimiAdapterShape["readThread"] = (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({
        threadId,
        turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      }));
    const rollbackThread: KimiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        if (!Number.isInteger(numTurns) || numTurns < 1)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Kimi ACP sessions do not support provider-side rollback.",
        });
      });
    const stopSession: KimiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(threadId, Effect.flatMap(requireSession(threadId), stopSessionInternal));
    const listSessions: KimiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
    const hasSession: KimiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });
    const stopAll: KimiAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (context) => stopSessionInternal(context), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(PubSub.shutdown(runtimeEvents)),
      ),
    );
    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
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
      streamEvents: Stream.fromPubSub(runtimeEvents),
    } satisfies KimiAdapterShape;
  });
}
