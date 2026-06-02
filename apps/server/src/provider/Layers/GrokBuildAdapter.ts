import {
  ApprovalRequestId,
  type GrokBuildSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
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
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { type ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import { AcpSessionRuntime, type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("grok-build");

export interface GrokBuildAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface GrokBuildSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  activeTurnId: TurnId | undefined;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function parseEnvJson(json: string): Record<string, string> {
  if (!json || !json.trim()) return {};
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error('Environment overrides must be a JSON object, e.g. {"XAI_LOG_LEVEL":"debug"}');
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      result[k] = String(v);
    } else {
      throw new Error(
        `Environment override for key '${k}' has invalid type. Expected string, number, or boolean.`,
      );
    }
  }
  return result;
}

export function resolveGrokBuildAcpBaseModelId(model: string | undefined): string {
  if (!model) {
    return "grok-build";
  }
  if (model === "composer-2.5" || model === "grok-composer-2.5-fast") {
    return "grok-composer-2.5-fast";
  }
  return model;
}

export function applyGrokBuildModelSelection<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly model: string | undefined;
  readonly mapError: (cause: import("effect-acp/errors").AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (!input.model) return;
    const resolvedModel = resolveGrokBuildAcpBaseModelId(input.model);
    yield* input.runtime.setModel(resolvedModel).pipe(Effect.mapError(input.mapError));
  });
}

export function makeGrokBuildAdapter(
  settings: GrokBuildSettings,
  options?: GrokBuildAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok-build");
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GrokBuildSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Grok runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to emit Grok Build session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => nativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

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
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokBuildSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GrokBuildSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session" as const,
      },
      startSession: (input) =>
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

            const cwd = path.resolve(input.cwd.trim());
            const cwdExists = yield* fileSystem.exists(cwd).pipe(
              Effect.mapError(
                (error) =>
                  new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: `Failed to access project root: ${error.message}`,
                  }),
              ),
            );
            if (!cwdExists) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Project root directory does not exist: ${cwd}`,
              });
            }

            const envOverrides = yield* Effect.try({
              try: () => parseEnvJson(settings.envJson),
              catch: (err: any) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: err.message || "Invalid environment overrides.",
                }),
            });

            const existing = sessions.get(input.threadId);
            if (existing && !existing.stopped) {
              yield* stopSessionInternal(existing);
            }

            const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
            const sessionScope = yield* Scope.make("sequential");
            let sessionScopeTransferred = false;
            yield* Effect.addFinalizer(() =>
              sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
            );

            const acpNativeLoggers = makeAcpNativeLoggers({
              nativeEventLogger,
              provider: PROVIDER,
              threadId: input.threadId,
            });

            const command = settings.command || "grok";
            const args = settings.args || ["agent", "stdio"];

            const processEnv = { ...process.env, ...options?.environment, ...envOverrides };

            const acp = yield* Effect.gen(function* () {
              const acpContext = yield* Layer.build(
                AcpSessionRuntime.layer({
                  spawn: {
                    command,
                    args,
                    cwd,
                    env: processEnv,
                  },
                  cwd,
                  clientInfo: { name: "t3-code", version: "0.0.0" },
                  authMethodId: "cached_token",
                  setModelStrategy: "sessionSetModel",
                  ...acpNativeLoggers,
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
            }).pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (error) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: error.message ?? String(error),
                    cause: error,
                  }),
              ),
            );

            let ctx!: GrokBuildSessionContext;

            const started = yield* Effect.gen(function* () {
              yield* acp.handleRequestPermission((params) =>
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
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
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : {
                            outcome: "selected" as const,
                            optionId: acpPermissionOutcome(resolved),
                          },
                  };
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new EffectAcpErrors.AcpTransportError({
                        detail: "Failed to process Grok ACP permission event.",
                        cause,
                      }),
                  ),
                ),
              );
              return yield* acp.start();
            }).pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

            if (input.modelSelection) {
              yield* applyGrokBuildModelSelection({
                runtime: acp,
                model: input.modelSelection.model,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
            }

            const now = yield* nowIso;
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd,
              model: input.modelSelection?.model ?? "grok-build",
              threadId: input.threadId,
              createdAt: now,
              updatedAt: now,
            };

            ctx = {
              threadId: input.threadId,
              session,
              scope: sessionScope,
              acp,
              notificationFiber: undefined,
              pendingApprovals,
              activeTurnId: undefined,
              stopped: false,
            };

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
              payload: { state: "ready", reason: "Grok Build ACP session ready" },
            });
            yield* offerRuntimeEvent({
              type: "thread.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              payload: { providerThreadId: started.sessionId },
            });

            const nf = yield* Stream.runDrain(
              Stream.mapEffect(acp.getEvents(), (event) =>
                Effect.gen(function* () {
                  switch (event._tag) {
                    case "ModeChanged":
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
                    case "ContentDelta":
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
                    default:
                      return;
                  }
                }),
              ),
            ).pipe(
              Effect.catchCause((_cause) => {
                if (ctx.stopped) return Effect.void;
                return makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent({
                      type: "runtime.error",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: {
                        message: "ACP session event stream closed unexpectedly.",
                        class: "transport_error",
                        detail: { errorCode: "StreamClosed" },
                      },
                    }),
                  ),
                  Effect.asVoid,
                );
              }),
              Effect.forkIn(sessionScope),
            );
            ctx.notificationFiber = nf as Fiber.Fiber<void, never>;
            sessions.set(input.threadId, ctx);
            sessionScopeTransferred = true;

            return session;
          }).pipe(Effect.scoped),
        ),

      sendTurn: (input) =>
        withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const turnId = TurnId.make(yield* randomUUIDv4);
            const turnModelSelection =
              input.modelSelection?.instanceId === boundInstanceId
                ? input.modelSelection
                : undefined;
            const model = turnModelSelection?.model ?? ctx.session.model;
            const resolvedModel = resolveGrokBuildAcpBaseModelId(model);

            if (model !== undefined) {
              yield* applyGrokBuildModelSelection({
                runtime: ctx.acp,
                model,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
            }

            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              model: resolvedModel,
            };

            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: resolvedModel },
            });

            const promptText = input.input?.trim() ?? "";
            const payload: Omit<EffectAcpSchema.PromptRequest, "sessionId"> = {
              prompt: [
                {
                  type: "text",
                  text: promptText,
                },
              ],
            };
            yield* logNative(input.threadId, "session/prompt", payload, "acp.jsonrpc");

            // Fork the prompt so we don't block `sendTurn`
            yield* ctx.acp.prompt(payload).pipe(
              Effect.tap((result) =>
                logNative(input.threadId, "session/prompt(response)", result, "acp.jsonrpc"),
              ),
              Effect.flatMap((result) =>
                makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent({
                      type: "turn.completed",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      payload: {
                        state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                        stopReason: result.stopReason ?? null,
                      },
                    }),
                  ),
                ),
              ),
              Effect.catchCause((_cause) => {
                if (ctx.stopped) return Effect.void;
                return makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    offerRuntimeEvent({
                      type: "runtime.error",
                      ...stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: ctx.activeTurnId,
                      payload: {
                        message: "Failed to send prompt to Grok Build CLI.",
                        class: "provider_error",
                        detail: { errorCode: "PromptFailed" },
                      },
                    }),
                  ),
                  Effect.asVoid,
                );
              }),
              Effect.forkIn(ctx.scope),
            );

            return {
              threadId: input.threadId,
              turnId,
            };
          }),
        ),

      interruptTurn: (threadId) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            yield* ctx.acp.cancel.pipe(Effect.ignore);
          }),
        ),

      respondToRequest: (threadId, requestId, decision) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const pending = ctx.pendingApprovals.get(requestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToRequest",
                detail: `No pending approval request found for ID '${requestId}'.`,
              });
            }
            yield* Deferred.succeed(pending.decision, decision);
          }),
        ),

      stopSession: (threadId) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            yield* stopSessionInternal(ctx);
          }),
        ),

      hasSession: (threadId) =>
        Effect.sync(() => {
          const ctx = sessions.get(threadId);
          return ctx !== undefined && !ctx.stopped;
        }),

      streamEvents: Stream.fromPubSub(runtimeEventPubSub),

      respondToUserInput: () =>
        Effect.die(new Error("respondToUserInput not implemented for Grok Build")),
      listSessions: () =>
        Effect.succeed(
          Array.from(sessions.values())
            .filter((s) => !s.stopped)
            .map((s) => s.session),
        ),
      readThread: () => Effect.die(new Error("readThread not implemented")),
      rollbackThread: () => Effect.die(new Error("rollbackThread not implemented")),
      stopAll: () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }),
    };

    return adapter;
  });
}
