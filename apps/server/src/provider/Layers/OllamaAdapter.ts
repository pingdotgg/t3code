/**
 * OllamaAdapter — HTTP-based provider adapter for Ollama local LLM server.
 *
 * Unlike the CLI-based providers (Codex, Claude, Cursor, Grok, OpenCode)
 * which communicate via ACP, Ollama exposes a REST API. This adapter drives
 * `/api/chat` with streaming to provide basic chat sessions: text in, text
 * out, with content delta events.
 *
 * Ollama does not natively support tool use, permission approvals, or MCP —
 * those adapter methods are no-ops or return structured errors where
 * appropriate.
 *
 * @module provider/Layers/OllamaAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type OllamaSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { OllamaAdapterShape } from "../Services/OllamaAdapter.ts";

const PROVIDER = ProviderDriverKind.make("ollama");

const OLLAMA_TIMEOUT_MS = 120_000;

// ── Ollama chat API shapes ────────────────────────────────────────────

interface OllamaChatMessage {
  readonly role: string;
  readonly content: string;
}

interface OllamaChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<OllamaChatMessage>;
  readonly stream: boolean;
}

interface OllamaChatResponseChunk {
  readonly message?: { readonly role: string; readonly content: string };
  readonly done: boolean;
}

// ── Session context ────────────────────────────────────────────────────

interface OllamaSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  messages: Array<OllamaChatMessage>;
  currentModelId: string | undefined;
  activeTurnId: TurnId | undefined;
  abortDeferred: Deferred.Deferred<void> | undefined;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveOllamaServerUrl(settings: OllamaSettings): string {
  const trimmed = settings.serverUrl.trim();
  return trimmed.length > 0 ? trimmed : "http://127.0.0.1:11434";
}

export interface OllamaAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
}

export function makeOllamaAdapter(
  ollamaSettings: OllamaSettings,
  options?: OllamaAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("ollama");
    const crypto = yield* Crypto.Crypto;
    const httpClient = yield* HttpClient.HttpClient;

    const sessions = new Map<ThreadId, OllamaSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Ollama runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
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

    const resolveModel = (modelSelection: unknown): string | undefined => {
      if (!isRecord(modelSelection)) return undefined;
      const model = modelSelection.model;
      return typeof model === "string" && model.trim() ? model.trim() : undefined;
    };

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OllamaSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: OllamaSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.abortDeferred) {
          yield* Deferred.succeed(ctx.abortDeferred, undefined).pipe(Effect.ignore);
        }
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    // ── startSession ──────────────────────────────────────────────────

    const startSession: OllamaAdapterShape["startSession"] = (input: ProviderSessionStartInput) =>
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

          const cwd = input.cwd?.trim() ?? "";
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Effect.void),
          );

          const requestedModel = resolveModel(input.modelSelection);
          if (!requestedModel) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "A model is required to start an Ollama session.",
            });
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(cwd ? { cwd } : {}),
            model: requestedModel,
            threadId: input.threadId,
            resumeCursor: undefined,
            createdAt: now,
            updatedAt: now,
          };

          const ctx: OllamaSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            messages: [],
            currentModelId: requestedModel,
            activeTurnId: undefined,
            abortDeferred: undefined,
            stopped: false,
          };

          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Ollama session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });

          return session;
        }).pipe(Effect.scoped),
      );

    // ── sendTurn ──────────────────────────────────────────────────────

    const sendTurn: OllamaAdapterShape["sendTurn"] = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const turnId = TurnId.make(yield* randomUUIDv4);

        const result = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);

            const text = input.input?.trim();
            if (!text) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Turn requires non-empty text input.",
              });
            }

            const turnModelSelection = resolveModel(input.modelSelection);
            const modelId = turnModelSelection ?? ctx.currentModelId ?? "llama3.2";
            ctx.currentModelId = modelId;

            ctx.activeTurnId = turnId;
            ctx.messages.push({ role: "user", content: text });
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              model: modelId,
            };

            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: modelId },
            });

            return { ctx, modelId, turnId };
          }),
        );

        if (result instanceof ProviderAdapterValidationError) {
          return yield* Effect.fail(result);
        }

        const { ctx, modelId } = result;

        // ── Stream the chat completion ────────────────────────────────

        const serverUrl = resolveOllamaServerUrl(ollamaSettings);
        const chatRequest: OllamaChatRequest = {
          model: modelId,
          messages: [...ctx.messages],
          stream: true,
        };

        const abortDeferred = yield* Deferred.make<void>();
        ctx.abortDeferred = abortDeferred;

        let assistantContent = "";

        const streamResult = yield* Effect.gen(function* () {
          const request = HttpClientRequest.post(`${serverUrl}/api/chat`).pipe(
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyJson(chatRequest),
          );
          const response = yield* httpClient.execute(request).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "api/chat",
                  detail: `Failed to connect to Ollama server at ${serverUrl}.`,
                  cause,
                }),
            ),
          );

          if (response.status !== 200) {
            const errorBody = yield* HttpClientResponse.bodyToString(response).pipe(
              Effect.orElseSucceed(() => ""),
            );
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "api/chat",
              detail: `Ollama server returned HTTP ${response.status}: ${errorBody.slice(0, 500)}`,
            });
          }

          // Parse NDJSON stream
          const bodyStream = response.stream;
          let buffer = "";

          yield* Stream.runForEach(bodyStream, (chunk: Uint8Array) =>
            Effect.gen(function* () {
              buffer += Buffer.from(chunk).toString("utf-8");
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let parsed: OllamaChatResponseChunk;
                try {
                  parsed = JSON.parse(trimmed) as OllamaChatResponseChunk;
                } catch {
                  continue;
                }
                if (parsed.message?.content) {
                  assistantContent += parsed.message.content;
                  yield* offerRuntimeEvent({
                    type: "content.delta",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId,
                    payload: {
                      streamKind: "assistant_text",
                      delta: parsed.message.content,
                    },
                  });
                }
              }
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "api/chat",
                  detail: "Ollama streaming request failed.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.race(Deferred.await(abortDeferred).pipe(Effect.as(undefined))),
          Effect.timeoutOption(OLLAMA_TIMEOUT_MS),
        );

        // Record assistant response
        if (assistantContent) {
          ctx.messages.push({ role: "assistant", content: assistantContent });
        }

        yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const liveCtx = sessions.get(input.threadId);
            if (!liveCtx || liveCtx.stopped) return;

            const updatedAt = yield* nowIso;
            const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
            liveCtx.activeTurnId = undefined;
            liveCtx.session = {
              ...readySession,
              status: "ready",
              updatedAt,
            };

            if (streamResult._tag === "None") {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: "Ollama request timed out.",
                },
              });
            } else {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "completed",
                  stopReason: "end_turn",
                },
              });
            }
          }),
        );

        if (streamResult._tag === "None") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "api/chat",
            detail: "Ollama request timed out.",
          });
        }

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: undefined,
        } satisfies ProviderTurnStartResult;
      });

    // ── interruptTurn ──────────────────────────────────────────────────

    const interruptTurn: OllamaAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return;
        if (ctx.abortDeferred) {
          yield* Deferred.succeed(ctx.abortDeferred, undefined).pipe(Effect.ignore);
        }
        if (ctx.activeTurnId) {
          const interruptedTurnId = ctx.activeTurnId;
          ctx.activeTurnId = undefined;
          ctx.session = {
            ...ctx.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: yield* nowIso,
          };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: interruptedTurnId,
            payload: {
              state: "cancelled",
              stopReason: "cancelled",
            },
          });
        }
      });

    // ── respondToRequest (no-op for Ollama) ────────────────────────────

    const respondToRequest: OllamaAdapterShape["respondToRequest"] = (
      _threadId,
      _requestId,
      _decision,
    ) => Effect.void;

    // ── respondToUserInput (no-op for Ollama) ──────────────────────────

    const respondToUserInput: OllamaAdapterShape["respondToUserInput"] = (
      _threadId,
      _requestId,
      _answers,
    ) => Effect.void;

    // ── stopSession ────────────────────────────────────────────────────

    const stopSession: OllamaAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    // ── listSessions ───────────────────────────────────────────────────

    const listSessions: OllamaAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => ctx.session),
      );

    // ── hasSession ─────────────────────────────────────────────────────

    const hasSession: OllamaAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    // ── readThread ─────────────────────────────────────────────────────

    const readThread: OllamaAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return {
          threadId,
          turns: [],
        };
      });

    // ── rollbackThread ─────────────────────────────────────────────────

    const rollbackThread: OllamaAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        // Remove the last `numTurns * 2` messages (user + assistant per turn)
        const messagesToRemove = numTurns * 2;
        ctx.messages = ctx.messages.slice(0, Math.max(0, ctx.messages.length - messagesToRemove));
        return {
          threadId,
          turns: [],
        };
      });

    // ── stopAll ────────────────────────────────────────────────────────

    const stopAll: OllamaAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const allContexts = Array.from(sessions.values());
        yield* Effect.forEach(allContexts, (ctx) => stopSessionInternal(ctx), {
          discard: true,
        });
      });

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
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    } satisfies OllamaAdapterShape;
  });
}