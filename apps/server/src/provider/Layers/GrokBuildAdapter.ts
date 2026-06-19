import { pathToFileURL } from "node:url";

import {
  ApprovalRequestId,
  type ChatAttachment,
  type GrokBuildSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
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
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { type ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { mapAcpParsedSessionEvent } from "../acp/AcpSessionEventSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import {
  GROK_BUILD_EMBEDDED_FILE_MAX_BYTES,
  GROK_BUILD_RESUME_VERSION,
  buildGrokBuildPromptBlocks,
  makeGrokBuildAcpRuntime,
  mapGrokSlugToAcpModelId,
  parseEnvJson,
  parseGrokBuildResume,
  extractGrokAcpPromptCapabilities,
  type GrokAcpPromptCapabilities,
} from "../acp/GrokAcpSupport.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { CursorAskQuestionRequest, extractAskQuestions } from "../acp/CursorAcpExtension.ts";
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

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface GrokBuildSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  readonly promptCapabilities: GrokAcpPromptCapabilities;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  lastPlanFingerprint: string | undefined;
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

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export { buildGrokBuildPromptBlocks, mapGrokSlugToAcpModelId as resolveGrokBuildAcpBaseModelId };

export function applyGrokBuildModelSelection<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly model: string | undefined;
  readonly mapError: (cause: import("effect-acp/errors").AcpError) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (!input.model) return;
    const resolvedModel = mapGrokSlugToAcpModelId(input.model);
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
    const serverConfig = yield* ServerConfig;
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
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
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
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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

    const resolveAttachmentBlock = (
      cwd: string,
      attachment: ChatAttachment,
      promptCapabilities: GrokAcpPromptCapabilities,
    ): Effect.Effect<EffectAcpSchema.ContentBlock, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        if (attachment.type === "file") {
          const absolutePath = path.resolve(cwd, attachment.workspacePath);
          const uri = pathToFileURL(absolutePath).toString();
          const shouldEmbed =
            promptCapabilities.embeddedContext &&
            attachment.sizeBytes <= GROK_BUILD_EMBEDDED_FILE_MAX_BYTES &&
            (attachment.mimeType.startsWith("text/") ||
              attachment.mimeType === "application/json" ||
              attachment.mimeType.endsWith("+json") ||
              attachment.mimeType.endsWith("+xml"));
          if (shouldEmbed) {
            const bytes = yield* fileSystem.readFile(absolutePath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: `Failed to read attachment file: ${cause.message}.`,
                    cause,
                  }),
              ),
            );
            const text = Buffer.from(bytes).toString("utf8");
            return {
              type: "resource",
              resource: {
                uri,
                mimeType: attachment.mimeType,
                text,
              },
            } satisfies EffectAcpSchema.ContentBlock;
          }
          return {
            type: "resource_link",
            uri,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.sizeBytes,
          } satisfies EffectAcpSchema.ContentBlock;
        }

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
                detail: `Failed to read attachment file: ${cause.message}.`,
                cause,
              }),
          ),
        );
        if (promptCapabilities.image) {
          return {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          } satisfies EffectAcpSchema.ContentBlock;
        }
        return {
          type: "resource",
          resource: {
            uri: pathToFileURL(attachmentPath).toString(),
            mimeType: attachment.mimeType,
            blob: Buffer.from(bytes).toString("base64"),
          },
        } satisfies EffectAcpSchema.ContentBlock;
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
            const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
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

            const resumeSessionId = parseGrokBuildResume(input.resumeCursor)?.sessionId;

            const acp = yield* makeGrokBuildAcpRuntime({
              grokSettings: settings,
              ...(options?.environment ? { environment: options.environment } : {}),
              envOverrides,
              childProcessSpawner,
              cwd,
              ...(resumeSessionId ? { resumeSessionId } : {}),
              clientInfo: { name: "t3-code", version: "0.0.0" },
              ...acpNativeLoggers,
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
              yield* acp.handleExtRequest(
                "cursor/ask_question",
                CursorAskQuestionRequest,
                (params) =>
                  Effect.gen(function* () {
                    yield* logNative(input.threadId, "cursor/ask_question", params, "acp.jsonrpc");
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
                      payload: { questions: extractAskQuestions(params) },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "cursor/ask_question",
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
                    return { answers: resolved };
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new EffectAcpErrors.AcpTransportError({
                          detail: "Failed to process Grok ACP user-input event.",
                          cause,
                        }),
                    ),
                  ),
              );
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

            const promptCapabilities = extractGrokAcpPromptCapabilities(started.initializeResult);
            const now = yield* nowIso;
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd,
              model: input.modelSelection?.model ?? "grok-build",
              threadId: input.threadId,
              resumeCursor: {
                schemaVersion: GROK_BUILD_RESUME_VERSION,
                sessionId: started.sessionId,
              },
              createdAt: now,
              updatedAt: now,
            };

            ctx = {
              threadId: input.threadId,
              session,
              scope: sessionScope,
              acp,
              promptCapabilities,
              notificationFiber: undefined,
              pendingApprovals,
              pendingUserInputs,
              turns: [],
              activeTurnId: undefined,
              lastPlanFingerprint: undefined,
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
                makeEventStamp().pipe(
                  Effect.flatMap((stamp) =>
                    mapAcpParsedSessionEvent({
                      event,
                      provider: PROVIDER,
                      context: {
                        threadId: ctx.threadId,
                        activeTurnId: ctx.activeTurnId,
                      },
                      stamp,
                      offerRuntimeEvent,
                      onModeChanged: ({ modeId }) =>
                        offerRuntimeEvent({
                          type: "session.state.changed",
                          ...stamp,
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          payload: {
                            state: "ready",
                            reason: `Grok Build interaction mode changed to ${modeId}`,
                          },
                        }),
                      ...(nativeEventLogger
                        ? {
                            logNative: (threadId, method, payload) =>
                              logNative(threadId, method, payload, "acp.jsonrpc").pipe(
                                Effect.ignore,
                              ),
                          }
                        : {}),
                      planState: ctx,
                      encodePlanPayload: encodeJsonStringForDiagnostics,
                    }),
                  ),
                ),
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
            const resolvedModel = mapGrokSlugToAcpModelId(model);

            if (model !== undefined) {
              yield* applyGrokBuildModelSelection({
                runtime: ctx.acp,
                model,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });
            }

            const attachments = input.attachments ?? [];
            const sessionCwd = ctx.session.cwd?.trim();
            if (attachments.length > 0 && !sessionCwd) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Attachments require a session cwd.",
              });
            }

            const attachmentBlocks = yield* Effect.forEach(
              attachments,
              (attachment) =>
                resolveAttachmentBlock(sessionCwd ?? "", attachment, ctx.promptCapabilities),
              { concurrency: 1 },
            );
            const promptBlocks = buildGrokBuildPromptBlocks({
              text: input.input,
              attachmentBlocks,
            });
            if (promptBlocks.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text or attachments.",
              });
            }

            ctx.activeTurnId = turnId;
            ctx.lastPlanFingerprint = undefined;
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

            const payload: Omit<EffectAcpSchema.PromptRequest, "sessionId"> = {
              prompt: promptBlocks,
            };
            yield* logNative(input.threadId, "session/prompt", payload, "acp.jsonrpc");

            // Fork the prompt so we don't block `sendTurn`
            yield* ctx.acp.prompt(payload).pipe(
              Effect.tap((result) =>
                logNative(input.threadId, "session/prompt(response)", result, "acp.jsonrpc"),
              ),
              Effect.tap((result) =>
                Effect.sync(() => {
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptBlocks, result }] });
                }),
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
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        ),

      interruptTurn: (threadId) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
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

      respondToUserInput: (threadId, requestId, answers) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const pending = ctx.pendingUserInputs.get(requestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "cursor/ask_question",
                detail: `Unknown pending user-input request: ${requestId}`,
              });
            }
            yield* Deferred.succeed(pending.answers, answers);
          }),
        ),
      listSessions: () =>
        Effect.succeed(
          Array.from(sessions.values())
            .filter((s) => !s.stopped)
            .map((s) => s.session),
        ),
      readThread: (threadId) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            return { threadId, turns: ctx.turns };
          }),
        ),
      rollbackThread: (threadId, numTurns) =>
        withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (!Number.isInteger(numTurns) || numTurns < 1) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "numTurns must be an integer >= 1.",
              });
            }
            const nextLength = Math.max(0, ctx.turns.length - numTurns);
            ctx.turns.splice(nextLength);
            return { threadId, turns: ctx.turns };
          }),
        ),
      stopAll: () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }),
    };

    return adapter;
  });
}
