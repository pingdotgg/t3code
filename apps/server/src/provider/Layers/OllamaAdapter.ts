import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  EventId,
  OllamaSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import type { OllamaAdapterShape } from "../Services/OllamaAdapter.ts";
import { ProviderAdapterRequestError, ProviderAdapterSessionClosedError, ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";
import { ollamaChat, type OllamaChatMessage, type OllamaRuntimeError } from "../ollamaRuntime.js";
import { OLLAMA_TOOL_DEFINITIONS, executeOllamaTool, classifyOllamaToolItemType, classifyOllamaRequestType, summarizeOllamaToolCall } from "../OllamaTools.js";

const PROVIDER = ProviderDriverKind.make("ollama");

interface PendingApproval {
  readonly requestType: string;
  readonly detail: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface OllamaSessionContext {
  session: ProviderSession;
  readonly threadId: ThreadId;
  readonly messages: OllamaChatMessage[];
  readonly runtimeEvents: Queue.Queue<ProviderRuntimeEvent>;
  readonly stopped: Ref.Ref<boolean>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  activeModel: string;
  activeTurnId: TurnId | undefined;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: string;
}) =>
  Effect.gen(function* () {
    const uuid = yield* Random.nextUUIDv4;
    const createdAt = yield* nowIso;
    return {
      eventId: EventId.make(uuid),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    };
  });

export const makeOllamaAdapter = (
  ollamaSettings: OllamaSettings,
  processEnv: Record<string, string | undefined>,
  options?: { readonly instanceId?: ProviderInstanceId },
) =>
  Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("ollama");
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OllamaSessionContext>();
    const apiKey = processEnv.OLLAMA_API_KEY;

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        sessions.clear();
        yield* Queue.shutdown(runtimeEvents);
      }),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const startSession: OllamaAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input: ProviderSessionStartInput) {
        sessions.delete(input.threadId);
        const createdAt = yield* nowIso;
        const effectiveModel =
          (input.modelSelection?.model?.trim().length ?? 0) > 0
            ? input.modelSelection!.model
            : ollamaSettings.model?.trim() || "qwen2.5:7b";
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd ?? process.cwd(),
          model: effectiveModel,
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        const stopped = yield* Ref.make(false);
        sessions.set(input.threadId, {
          session,
          threadId: input.threadId,
          messages: [],
          runtimeEvents,
          stopped,
          pendingApprovals: new Map(),
          activeModel: effectiveModel,
          activeTurnId: undefined,
        });
        return session;
      },
    );

    const sendTurn: OllamaAdapterShape["sendTurn"] = Effect.fn("sendTurn")(
      function* (input: ProviderSendTurnInput) {
        const context = sessions.get(input.threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: input.threadId });
        }
        if (yield* Ref.get(context.stopped)) {
          return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId: input.threadId });
        }
        const text = input.input?.trim();
        if (!text || text.length === 0) {
          return yield* new ProviderAdapterValidationError({ provider: PROVIDER, operation: "sendTurn", issue: "Ollama turns require text input." });
        }
        const model = input.modelSelection?.model ?? context.activeModel;
        context.activeModel = model;
        const turnId = TurnId.make(`ollama-turn-${yield* Random.nextUUIDv4}`);
        context.activeTurnId = turnId;
        context.messages.push({ role: "user", content: text });
        context.session = { ...context.session, status: "running", activeTurnId: turnId } as ProviderSession;
        const cwd = context.session.cwd ?? process.cwd();
        const runtimeMode = context.session.runtimeMode ?? "full-access";
        const runtimeCtx = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(runtimeCtx);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: { model },
        });

        const runTurnLoop = Effect.gen(function* () {
          let looping = true;
          while (looping) {
            if (yield* Ref.get(context.stopped)) break;

            const response = yield* ollamaChat({
              baseUrl: ollamaSettings.baseUrl,
              apiKey,
              model,
              messages: context.messages,
              tools: OLLAMA_TOOL_DEFINITIONS,
            }).pipe(
              Effect.catch((error: OllamaRuntimeError) =>
                Effect.gen(function* () {
                  context.activeTurnId = undefined;
                  context.session = { ...context.session, status: "error", lastError: error.detail } as ProviderSession;
                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                    type: "turn.completed",
                    payload: { state: "failed", errorMessage: error.detail },
                  });
                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId })),
                    type: "runtime.error",
                    payload: { message: error.detail, class: "provider_error" },
                  });
                  return yield* Effect.fail(error);
                }),
              ),
            );

            const toolCalls = response.message.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
              // Append assistant message with tool_calls to history
              context.messages.push({ role: "assistant", content: response.message.content ?? "", tool_calls: toolCalls });

              for (const toolCall of toolCalls) {
                if (yield* Ref.get(context.stopped)) {
                  looping = false;
                  break;
                }

                const toolName = toolCall.function.name;
                const toolArgs = toolCall.function.arguments;
                const itemType = classifyOllamaToolItemType(toolName);
                const requestType = classifyOllamaRequestType(toolName);
                const detail = summarizeOllamaToolCall(toolName, toolArgs);
                const itemId = `ollama:tool:${turnId}:${toolName}:${yield* Random.nextUUIDv4}`;

                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                  type: "item.started",
                  payload: { itemType, title: detail },
                });

                let approved = true;
                if (runtimeMode !== "full-access") {
                  const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
                  const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
                  const pendingApproval: PendingApproval = { requestType, detail, decision: decisionDeferred };
                  context.pendingApprovals.set(requestId, pendingApproval);

                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                    type: "request.opened",
                    requestId: RuntimeRequestId.make(requestId),
                    payload: { requestType, detail, args: { toolName, input: toolArgs } },
                  });

                  const decision = yield* Deferred.await(decisionDeferred);
                  context.pendingApprovals.delete(requestId);

                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                    type: "request.resolved",
                    requestId: RuntimeRequestId.make(requestId),
                    payload: { requestType, decision },
                  });

                  if (decision === "cancel" || decision === "decline") {
                    approved = false;
                    looping = false;
                    yield* emit({
                      ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                      type: "item.completed",
                      payload: { itemType, status: "declined", title: detail },
                    });
                    break;
                  }
                }

                if (approved) {
                  const toolResult = yield* executeOllamaTool(toolCall, cwd).pipe(
                    Effect.catch((err) => Effect.succeed(`Error: ${err.detail}`)),
                  );

                  context.messages.push({ role: "tool", content: toolResult });

                  yield* emit({
                    ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                    type: "item.completed",
                    payload: { itemType, status: "completed", title: detail, detail: toolResult.slice(0, 500) || undefined },
                  });
                }
              }
            } else {
              // No tool calls → final assistant message
              const content = response.message.content ?? "";
              context.messages.push({ role: "assistant", content });

              if (content.length > 0) {
                const itemId = `ollama:item:${turnId}:assistant`;
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta: content },
                });
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId, itemId })),
                  type: "item.completed",
                  payload: { itemType: "assistant_message", status: "completed", title: "Assistant message", detail: content },
                });
              }

              looping = false;
            }
          }

          const isStopped = yield* Ref.get(context.stopped);
          context.activeTurnId = undefined;
          context.session = { ...context.session, status: "ready" } as ProviderSession;
          yield* emit({
            ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
            type: "turn.completed",
            payload: { state: isStopped ? "interrupted" : "completed" },
          });
        });

        runFork(runTurnLoop);
        return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
      },
    );

    const interruptTurn: OllamaAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId: ThreadId) {
        const context = sessions.get(threadId);
        if (context) {
          yield* Ref.set(context.stopped, true);
          for (const [, pending] of context.pendingApprovals) {
            yield* Deferred.succeed(pending.decision, "cancel");
          }
          context.pendingApprovals.clear();
          context.activeTurnId = undefined;
          context.session = { ...context.session, status: "ready" } as ProviderSession;
        }
      },
    );

    const respondToRequest: OllamaAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
      function* (threadId: ThreadId, requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      },
    );

    const respondToUserInput: OllamaAdapterShape["respondToUserInput"] = Effect.fn("respondToUserInput")(function* () {});

    const stopSession: OllamaAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId: ThreadId) {
        const context = sessions.get(threadId);
        if (context) {
          yield* Ref.set(context.stopped, true);
          for (const [, pending] of context.pendingApprovals) {
            yield* Deferred.succeed(pending.decision, "cancel");
          }
          context.pendingApprovals.clear();
          sessions.delete(threadId);
        }
      },
    );

    const listSessions: OllamaAdapterShape["listSessions"] = Effect.fn("listSessions")(
      function* () { return Array.from(sessions.values()).map((ctx) => ctx.session); },
    );

    const hasSession: OllamaAdapterShape["hasSession"] = Effect.fn("hasSession")(
      function* (threadId: ThreadId) { return sessions.has(threadId); },
    );

    const readThread: OllamaAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId: ThreadId) {
        if (!sessions.has(threadId)) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        return { threadId, turns: [] };
      },
    );

    const rollbackThread: OllamaAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId: ThreadId, numTurns: number) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        context.messages.splice(context.messages.length - numTurns * 2, numTurns * 2);
        return { threadId, turns: [] };
      },
    );

    const stopAll: OllamaAdapterShape["stopAll"] = Effect.fn("stopAll")(function* () {
      const keys = Array.from(sessions.keys());
      for (const threadId of keys) {
        yield* stopSession(threadId);
      }
    });

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
      streamEvents: Stream.fromQueue(runtimeEvents),
    } satisfies OllamaAdapterShape;
  });
