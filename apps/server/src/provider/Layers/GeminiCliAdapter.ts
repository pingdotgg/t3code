import { type ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { GeminiCliServerManager } from "../../geminiCliServerManager.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { GeminiCliAdapter, type GeminiCliAdapterShape } from "../Services/GeminiCliAdapter.ts";

const PROVIDER = "geminiCli" as const;

export interface GeminiCliAdapterLiveOptions {
  readonly manager?: GeminiCliServerManager;
  readonly makeManager?: () => GeminiCliServerManager;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(threadId: string, cause: unknown) {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown gemini cli session") || normalized.includes("unknown session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: string, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

export function makeGeminiCliAdapterLive(options: GeminiCliAdapterLiveOptions = {}) {
  return Layer.effect(
    GeminiCliAdapter,
    Effect.gen(function* () {
      const manager = options.manager ?? options.makeManager?.() ?? new GeminiCliServerManager();
      const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const listener = (event: ProviderRuntimeEvent) => {
            Effect.runFork(Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid));
          };
          manager.on("event", listener);
          return listener;
        }),
        (listener) =>
          Effect.gen(function* () {
            manager.off("event", listener);
            manager.stopAll();
            yield* Queue.shutdown(runtimeEventQueue);
          }),
      );

      const service = {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "restart-session",
        } as const,
        startSession: (input) =>
          Effect.tryPromise({
            try: () => manager.startSession(input),
            catch: (cause) => toRequestError(input.threadId, "session/start", cause),
          }),
        sendTurn: (input) => {
          if ((input.attachments?.length ?? 0) > 0) {
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Gemini CLI attachments are not supported yet.",
              }),
            );
          }

          return Effect.tryPromise({
            try: () => manager.sendTurn(input),
            catch: (cause) => toRequestError(input.threadId, "session/prompt", cause),
          });
        },
        interruptTurn: (threadId) =>
          Effect.tryPromise({
            try: () => manager.interruptTurn(threadId),
            catch: (cause) => toRequestError(threadId, "session/interrupt", cause),
          }),
        respondToRequest: (threadId, requestId, decision) =>
          Effect.tryPromise({
            try: () => manager.respondToRequest(threadId, requestId, decision),
            catch: (cause) => toRequestError(threadId, "permission/reply", cause),
          }),
        respondToUserInput: (threadId, requestId, answers) =>
          Effect.tryPromise({
            try: () => manager.respondToUserInput(threadId, requestId, answers),
            catch: (cause) => toRequestError(threadId, "question/reply", cause),
          }),
        stopSession: (threadId) =>
          Effect.sync(() => {
            manager.stopSession(threadId);
          }),
        listSessions: () => Effect.sync(() => manager.listSessions()),
        hasSession: (threadId) => Effect.sync(() => manager.hasSession(threadId)),
        readThread: (threadId) =>
          Effect.tryPromise({
            try: () => manager.readThread(threadId),
            catch: (cause) => toRequestError(threadId, "session/messages", cause),
          }),
        rollbackThread: (threadId, numTurns) => {
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "numTurns must be an integer >= 1.",
              }),
            );
          }

          return Effect.tryPromise({
            try: () => manager.rollbackThread(threadId),
            catch: (cause) => toRequestError(threadId, "session/revert", cause),
          });
        },
        stopAll: () =>
          Effect.sync(() => {
            manager.stopAll();
          }),
        streamEvents: Stream.fromQueue(runtimeEventQueue),
      } satisfies GeminiCliAdapterShape;

      return service;
    }),
  );
}

export const GeminiCliAdapterLive = makeGeminiCliAdapterLive();
