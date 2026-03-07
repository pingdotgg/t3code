import {
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, ServiceMap, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { CopilotAcpManager } from "../../copilotAcpManager.ts";
import { CopilotAdapter, type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";

const PROVIDER = "copilot" as const;

export interface CopilotAdapterLiveOptions {
  readonly manager?: CopilotAcpManager;
  readonly makeManager?: (services?: ServiceMap.ServiceMap<never>) => CopilotAcpManager;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  threadId: string,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown copilot session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
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

export const makeCopilotAdapterLive = (options?: CopilotAdapterLiveOptions) =>
  Layer.effect(
    CopilotAdapter,
    Effect.gen(function* () {
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const manager =
        options?.manager ??
        options?.makeManager?.() ??
        new CopilotAcpManager();

      const handleEvent = (event: ProviderRuntimeEvent) => {
        void Effect.runPromise(Queue.offer(eventQueue, event).pipe(Effect.asVoid));
      };
      manager.on("event", handleEvent);

      const streamEvents = Stream.fromQueue(eventQueue);

      const startSession: CopilotAdapterShape["startSession"] = (input) =>
        Effect.tryPromise({
          try: () =>
            manager.startSession({
              threadId: input.threadId,
              provider: "copilot",
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.modelOptions?.copilot?.reasoningEffort !== undefined
                ? { reasoningEffort: input.modelOptions.copilot.reasoningEffort }
                : {}),
              ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
              runtimeMode: input.runtimeMode,
            }),
          catch: (cause) => toRequestError(input.threadId, "session/start", cause),
        });

      const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
        Effect.tryPromise({
          try: () =>
            manager.sendTurn({
              threadId: input.threadId,
              ...(input.input !== undefined ? { input: input.input } : {}),
              ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.modelOptions?.copilot?.reasoningEffort !== undefined
                ? { reasoningEffort: input.modelOptions.copilot.reasoningEffort }
                : {}),
            }),
          catch: (cause) => toRequestError(input.threadId, "session/prompt", cause),
        });

      const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId, turnId) =>
        Effect.tryPromise({
          try: () => manager.interruptTurn(threadId, turnId),
          catch: (cause) => toRequestError(threadId, "session/cancel", cause),
        });

      const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
        threadId,
        requestId,
        decision,
      ) =>
        Effect.tryPromise({
          try: () => manager.respondToRequest(threadId, requestId, decision),
          catch: (cause) => toRequestError(threadId, "request/respond", cause),
        });

      const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (
        threadId,
        _requestId,
        _answers: ProviderUserInputAnswers,
      ) =>
        Effect.tryPromise({
          try: () => manager.respondToUserInput(),
          catch: (cause) => toRequestError(threadId, "user-input/respond", cause),
        });

      const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.stopSession(threadId),
          catch: (cause) => toRequestError(threadId, "session/stop", cause),
        });

      const listSessions: CopilotAdapterShape["listSessions"] = () =>
        Effect.promise(() => manager.listSessions());

      const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
        Effect.promise(() => manager.hasSession(threadId));

      const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
        Effect.tryPromise({
          try: () => manager.readThread(threadId),
          catch: (cause) => toRequestError(threadId, "thread/read", cause),
        });

      const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
        Effect.tryPromise({
          try: () => manager.rollbackThread(threadId, numTurns),
          catch: (cause) => toRequestError(threadId, "thread/rollback", cause),
        });

      const stopAll: CopilotAdapterShape["stopAll"] = () =>
        Effect.tryPromise({
          try: () => manager.stopAll(),
          catch: (cause) => toRequestError("_global", "provider/stopAll", cause),
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
        streamEvents,
      } satisfies CopilotAdapterShape;
    }),
  );
