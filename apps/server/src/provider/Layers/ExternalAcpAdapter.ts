/**
 * Adapter for standard ACP coding agents.
 *
 * This keeps the transport-independent session mapping in one place. Provider
 * drivers still own their executable, authentication method, and model rules.
 */
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  decideToolCallUpdateEmission,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionUpdateEvent,
  toolCallProgressLength,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import * as AcpSessionRuntimeModule from "../acp/AcpSessionRuntime.ts";
import type { AcpSpawnInput } from "../acp/AcpSessionRuntime.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const RESUME_SCHEMA_VERSION = 1 as const;

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface ExternalAcpSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly toolCalls: Map<string, { state: ReturnType<typeof parsePermissionRequest>["toolCall"] }>;
  activeTurnId: TurnId | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

export interface ExternalAcpAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly spawn: (cwd: string, environment?: NodeJS.ProcessEnv) => AcpSpawnInput;
  readonly authMethodId: string;
  readonly defaultModel?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function parseResumeCursor(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return record.schemaVersion === RESUME_SCHEMA_VERSION && typeof record.sessionId === "string"
    ? record.sessionId.trim() || undefined
    : undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlways = request.options.find((option) => option.kind === "allow_always");
  if (allowAlways?.optionId?.trim()) return allowAlways.optionId.trim();
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce?.optionId?.trim() || undefined;
}

function makeUnsupportedUserInputError(provider: ProviderDriverKind): ProviderAdapterError {
  return new ProviderAdapterValidationError({
    provider,
    operation: "respondToUserInput",
    issue: `Provider '${provider}' does not expose a supported structured user-input bridge.`,
  });
}

function normalizeAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterError {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof cause._tag === "string" &&
    cause._tag.startsWith("ProviderAdapter")
  ) {
    return cause as ProviderAdapterError;
  }
  return new ProviderAdapterProcessError({
    provider,
    threadId,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export const makeExternalAcpAdapter = Effect.fn("makeExternalAcpAdapter")(function* (
  options: ExternalAcpAdapterOptions,
): Effect.fn.Return<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const makeNativeLoggers = yield* makeAcpNativeLoggerFactory();
  const sessions = new Map<ThreadId, ExternalAcpSessionContext>();
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const now = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4;

  const nextStamp = () =>
    Effect.all({ eventId: uuid.pipe(Effect.map(EventId.make)), createdAt: now });
  const withLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(
      SynchronizedRef.modifyEffect(locks, (current) => {
        const currentLock = current.get(threadId);
        if (currentLock) return Effect.succeed([currentLock, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((created) => {
            const next = new Map(current);
            next.set(threadId, created);
            return [created, next] as const;
          }),
        );
      }),
      (lock) => lock.withPermit(effect),
    );
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ExternalAcpSessionContext, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    return session && !session.stopped
      ? Effect.succeed(session)
      : Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId }),
        );
  };
  const settleApprovals = (ctx: ExternalAcpSessionContext) =>
    Effect.forEach(
      ctx.pendingApprovals.values(),
      (pending) => Deferred.succeed(pending.decision, "cancel"),
      {
        discard: true,
      },
    );
  const stopInternal = (ctx: ExternalAcpSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      yield* settleApprovals(ctx);
      if (ctx.notificationFiber) yield* Fiber.interrupt(ctx.notificationFiber);
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      sessions.delete(ctx.threadId);
      yield* publish({
        type: "session.exited",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: ctx.threadId,
        payload: { exitKind: "graceful" },
      });
    });

  const startSession = (input: ProviderSessionStartInput) =>
    withLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== options.provider) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: `Expected provider '${options.provider}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopInternal(existing);
        const cwd = path.resolve(input.cwd.trim());
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred
            ? Effect.void
            : Effect.ignore(Scope.close(sessionScope, Exit.void)),
        );
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const ctx: ExternalAcpSessionContext = {
          threadId: input.threadId,
          session: undefined as never,
          scope: sessionScope,
          acp: undefined as never,
          notificationFiber: undefined,
          pendingApprovals,
          turns: [],
          toolCalls: new Map(),
          activeTurnId: undefined,
          promptsInFlight: 0,
          stopped: false,
        };
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const resumeSessionId = parseResumeCursor(input.resumeCursor);
        const acp = yield* AcpSessionRuntimeModule.make({
          spawn: options.spawn(cwd, options.environment),
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          authMethodId: options.authMethodId,
          ...(mcpSession
            ? {
                mcpServers: [
                  {
                    type: "http" as const,
                    name: "t3-code",
                    url: mcpSession.endpoint,
                    headers: [{ name: "Authorization", value: mcpSession.authorizationHeader }],
                  },
                ],
              }
            : {}),
          ...makeNativeLoggers({
            nativeEventLogger: options.nativeEventLogger,
            provider: options.provider,
            threadId: input.threadId,
          }),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: options.provider,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );
        ctx.acp = acp;

        yield* acp.handleRequestPermission((request) =>
          Effect.gen(function* () {
            if (input.runtimeMode === "full-access") {
              const optionId = selectAutoApprovedPermissionOption(request);
              if (optionId) return { outcome: { outcome: "selected" as const, optionId } };
            }
            const permission = parsePermissionRequest(request);
            const requestId = ApprovalRequestId.make(yield* uuid);
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { decision, kind: permission.kind });
            yield* publish(
              makeAcpRequestOpenedEvent({
                stamp: yield* nextStamp(),
                provider: options.provider,
                threadId: input.threadId,
                turnId: ctx.activeTurnId,
                requestId: runtimeRequestId,
                permissionRequest: permission,
                detail: permission.detail ?? "Provider permission requested.",
                args: request,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: request,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            yield* publish(
              makeAcpRequestResolvedEvent({
                stamp: yield* nextStamp(),
                provider: options.provider,
                threadId: input.threadId,
                turnId: ctx.activeTurnId,
                requestId: runtimeRequestId,
                permissionRequest: permission,
                decision: resolved,
              }),
            );
            return resolved === "cancel"
              ? { outcome: { outcome: "cancelled" as const } }
              : {
                  outcome: {
                    outcome: "selected" as const,
                    optionId: acpPermissionOutcome(resolved),
                  },
                };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  operation: "call-rpc",
                  method: "session/request_permission",
                  detail: "Failed to handle an ACP permission request in T3 Code.",
                  cause,
                }),
            ),
          ),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({ action: { action: "cancel" as const } }),
        );
        yield* acp.handleSessionUpdate((notification) =>
          Effect.gen(function* () {
            const parsed = parseSessionUpdateEvent(notification);
            for (const event of parsed.events) {
              switch (event._tag) {
                case "ModeChanged":
                  break;
                case "AssistantItemStarted":
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp: yield* nextStamp(),
                      provider: options.provider,
                      threadId: input.threadId,
                      turnId: ctx.activeTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.started",
                    }),
                  );
                  break;
                case "AssistantItemCompleted":
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp: yield* nextStamp(),
                      provider: options.provider,
                      threadId: input.threadId,
                      turnId: ctx.activeTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.completed",
                    }),
                  );
                  break;
                case "PlanUpdated":
                  yield* publish(
                    makeAcpPlanUpdatedEvent({
                      stamp: yield* nextStamp(),
                      provider: options.provider,
                      threadId: input.threadId,
                      turnId: ctx.activeTurnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  break;
                case "ToolCallUpdated": {
                  const previous = ctx.toolCalls.get(event.toolCall.toolCallId)?.state;
                  const merged = mergeToolCallState(previous, event.toolCall);
                  const decision = decideToolCallUpdateEmission({
                    previous,
                    next: merged,
                    lastEmittedDetailLength: previous
                      ? toolCallProgressLength(previous)
                      : undefined,
                    skippedSinceEmit: 0,
                  });
                  ctx.toolCalls.set(event.toolCall.toolCallId, { state: merged });
                  if (
                    decision.emit ||
                    merged.status === "completed" ||
                    merged.status === "failed"
                  ) {
                    yield* publish(
                      makeAcpToolCallEvent({
                        stamp: yield* nextStamp(),
                        provider: options.provider,
                        threadId: input.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: merged,
                        rawPayload: event.rawPayload,
                      }),
                    );
                  }
                  break;
                }
                case "ContentDelta":
                  yield* publish(
                    makeAcpContentDeltaEvent({
                      stamp: yield* nextStamp(),
                      provider: options.provider,
                      threadId: input.threadId,
                      turnId: ctx.activeTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  break;
              }
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  operation: "call-rpc",
                  method: "session/update",
                  detail: "Failed to process an ACP session update in T3 Code.",
                  cause,
                }),
            ),
          ),
        );
        const started = yield* acp
          .start()
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/start", cause),
            ),
          );
        const selectedModel = input.modelSelection?.model ?? options.defaultModel;
        if (selectedModel) {
          yield* acp
            .setSessionModel(selectedModel)
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(options.provider, input.threadId, "session/set_model", cause),
              ),
            );
        }
        const timestamp = yield* now;
        ctx.session = {
          provider: options.provider,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          ...(selectedModel && !input.modelSelection?.model ? { model: selectedModel } : {}),
          threadId: input.threadId,
          resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: started.sessionId },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        ctx.notificationFiber = yield* Stream.runDrain(acp.getEvents()).pipe(
          Effect.forkIn(sessionScope),
        );
        sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;
        yield* publish({
          type: "session.started",
          ...(yield* nextStamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* nextStamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { state: "ready", reason: "ACP session ready" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* nextStamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return ctx.session;
      }).pipe(Effect.scoped),
    );

  const sendTurn = (input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      if (!input.input?.trim() && !input.attachments?.length) {
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }
      const turnId = TurnId.make(yield* uuid);
      ctx.activeTurnId = turnId;
      const selectedModel = input.modelSelection?.model;
      if (selectedModel) {
        yield* ctx.acp
          .setSessionModel(selectedModel)
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/set_model", cause),
            ),
          );
        ctx.session = { ...ctx.session, model: selectedModel, updatedAt: yield* now };
      }
      ctx.promptsInFlight += 1;
      const prompt: Array<EffectAcpSchema.ContentBlock> = [];
      if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) continue;
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: options.provider,
                method: "session/prompt",
                detail: cause.message,
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
      yield* publish({
        type: "turn.started",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: input.threadId,
        turnId,
        payload: {},
      });
      const result = yield* ctx.acp.prompt({ prompt }).pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(options.provider, input.threadId, "session/prompt", cause),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
          }),
        ),
      );
      ctx.turns.push({ id: turnId, items: [{ prompt, result }] });
      ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* now };
      yield* publish({
        type: "turn.completed",
        ...(yield* nextStamp()),
        provider: options.provider,
        threadId: input.threadId,
        turnId,
        payload: {
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason ?? null,
        },
      });
      return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
    });

  const interruptTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      yield* settleApprovals(ctx);
      yield* ctx.acp.cancel.pipe(
        Effect.mapError((cause) =>
          mapAcpToAdapterError(options.provider, threadId, "session/cancel", cause),
        ),
      );
    });

  const respondToRequest = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending)
        return yield* new ProviderAdapterRequestError({
          provider: options.provider,
          method: "session/request_permission",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      yield* Deferred.succeed(pending.decision, decision);
    });

  const respondToUserInput = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap(() => Effect.fail(makeUnsupportedUserInputError(options.provider))),
    );
  const readThread = (
    threadId: ThreadId,
  ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
    requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns })));
  const rollbackThread = (threadId: ThreadId, numTurns: number) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1)
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
      return { threadId, turns: ctx.turns };
    });
  const stopSession = (threadId: ThreadId) =>
    withLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopInternal)));
  const listSessions = () =>
    Effect.succeed(Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));
  const hasSession = (threadId: ThreadId) =>
    Effect.succeed(sessions.get(threadId)?.stopped === false);
  const stopAll = () => Effect.forEach(sessions.values(), stopInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(Effect.andThen(PubSub.shutdown(runtimeEvents))),
  );
  return {
    provider: options.provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      startSession(input).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, input.threadId, cause)),
      ),
    sendTurn: (input) =>
      sendTurn(input).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, input.threadId, cause)),
      ),
    interruptTurn: (threadId) =>
      interruptTurn(threadId).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, threadId, cause)),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      respondToRequest(threadId, requestId, decision).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, threadId, cause)),
      ),
    respondToUserInput: (threadId, requestId, answers) =>
      respondToUserInput(threadId, requestId, answers).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, threadId, cause)),
      ),
    stopSession: (threadId) =>
      stopSession(threadId).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, threadId, cause)),
      ),
    listSessions,
    hasSession,
    readThread: (threadId) =>
      readThread(threadId).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, threadId, cause)),
      ),
    rollbackThread: (threadId, numTurns) =>
      rollbackThread(threadId, numTurns).pipe(
        Effect.mapError((cause) => normalizeAdapterError(options.provider, threadId, cause)),
      ),
    stopAll: () =>
      stopAll().pipe(
        Effect.mapError((cause) =>
          normalizeAdapterError(options.provider, ThreadId.make("all"), cause),
        ),
      ),
    streamEvents: Stream.fromPubSub(runtimeEvents),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
