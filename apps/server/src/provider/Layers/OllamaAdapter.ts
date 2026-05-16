import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";
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
  activeFiber: Fiber.Fiber<unknown, unknown> | undefined;
  /** message count at the start of each turn (indexed by turn number, 0 = before first user message) */
  readonly turnMessageIndices: number[];
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
        for (const [, context] of sessions) {
          if (context.activeFiber) {
            yield* Ref.set(context.stopped, true);
            yield* Fiber.interrupt(context.activeFiber);
          }
        }
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
          activeFiber: undefined,
          turnMessageIndices: [0],
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
        const text = input.input?.trim();
        if (!text || text.length === 0) {
          return yield* new ProviderAdapterValidationError({ provider: PROVIDER, operation: "sendTurn", issue: "Ollama turns require text input." });
        }
        // A previous turn's fiber must be fully terminated before a new turn
        // starts, otherwise two fibers would mutate context.messages
        // concurrently. Fiber.interrupt awaits the fiber's onExit, so the
        // prior turn is fully closed (turn.completed emitted) once this returns.
        if (context.activeFiber) {
          yield* Fiber.interrupt(context.activeFiber);
          context.activeFiber = undefined;
        }
        // Clear any interrupt flag from a previous interruptTurn; stopSession
        // deletes the session entirely, so a closed session is already caught
        // by the not-found check above.
        yield* Ref.set(context.stopped, false);
        const model = input.modelSelection?.model ?? context.activeModel;
        context.activeModel = model;
        const turnId = TurnId.make(`ollama-turn-${yield* Random.nextUUIDv4}`);
        context.activeTurnId = turnId;
        // Record this turn's start boundary in the message array so
        // rollbackThread can splice whole turns (incl. tool messages),
        // regardless of whether the turn later succeeds or fails.
        const lastIndex = context.turnMessageIndices[context.turnMessageIndices.length - 1];
        if (lastIndex !== context.messages.length) {
          context.turnMessageIndices.push(context.messages.length);
        }
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

        // Captured by the ollamaChat catch below and read in onExit to tell a
        // real provider error apart from a fiber interruption. This relies on
        // ollamaChat being the loop's ONLY fallible step — keep it that way,
        // or onExit will misclassify an interruption as a failure.
        let turnError: OllamaRuntimeError | undefined;

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
              Effect.catch((error: OllamaRuntimeError) => {
                turnError = error;
                return Effect.fail(error);
              }),
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
        }).pipe(
          // onExit runs whether the loop completes, fails, or is interrupted,
          // so turn.completed is emitted exactly once on every path.
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              context.activeTurnId = undefined;
              context.activeFiber = undefined;
              if (Exit.isFailure(exit) && turnError) {
                context.session = { ...context.session, status: "error", lastError: turnError.detail } as ProviderSession;
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                  type: "turn.completed",
                  payload: { state: "failed", errorMessage: turnError.detail },
                });
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId })),
                  type: "runtime.error",
                  payload: { message: turnError.detail, class: "provider_error" },
                });
              } else {
                // Failure without turnError means the fiber was interrupted.
                const isStopped = yield* Ref.get(context.stopped);
                context.session = { ...context.session, status: "ready" } as ProviderSession;
                yield* emit({
                  ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                  type: "turn.completed",
                  payload: { state: isStopped || Exit.isFailure(exit) ? "interrupted" : "completed" },
                });
              }
            }),
          ),
        );

        const fiber = runFork(runTurnLoop);
        context.activeFiber = fiber;
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
          // Interrupt the running fiber and await its termination. The fiber's
          // onExit clears activeTurnId/activeFiber and emits turn.completed.
          if (context.activeFiber) {
            yield* Fiber.interrupt(context.activeFiber);
            context.activeFiber = undefined;
          }
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
          if (context.activeFiber) {
            yield* Fiber.interrupt(context.activeFiber);
            context.activeFiber = undefined;
          }
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
        // turnMessageIndices holds the message-array offset at the start of
        // each turn, so a rollback splices whole turns (incl. tool messages).
        const indices = context.turnMessageIndices;
        if (numTurns <= 0 || indices.length === 0) return { threadId, turns: [] };
        const keepTurns = Math.max(0, indices.length - numTurns);
        const rollbackIndex = indices[keepTurns] ?? indices[0] ?? 0;
        context.messages.splice(rollbackIndex);
        context.turnMessageIndices.splice(keepTurns);
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
