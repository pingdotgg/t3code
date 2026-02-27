/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Wraps a Claude runtime bridge behind the `ClaudeCodeAdapter` service contract
 * and maps runtime failures into the shared `ProviderAdapterError` algebra.
 *
 * @module ClaudeCodeAdapterLive
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionId,
  ProviderSessionStartInput,
  ProviderTurnId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterShape,
} from "../Services/ClaudeCodeAdapter.ts";

const PROVIDER = "claudeCode" as const;

export interface ClaudeCodeRuntime {
  readonly startSession: (input: ProviderSessionStartInput) => Promise<ProviderSession>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>;
  readonly interruptTurn: (sessionId: ProviderSessionId, turnId?: ProviderTurnId) => Promise<void>;
  readonly readThread: (sessionId: ProviderSessionId) => Promise<ProviderThreadSnapshot>;
  readonly rollbackThread: (
    sessionId: ProviderSessionId,
    numTurns: number,
  ) => Promise<ProviderThreadSnapshot>;
  readonly respondToRequest: (
    sessionId: ProviderSessionId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly stopSession: (sessionId: ProviderSessionId) => void;
  readonly listSessions: () => ReadonlyArray<ProviderSession>;
  readonly hasSession: (sessionId: ProviderSessionId) => boolean;
  readonly stopAll: () => void;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

export interface ClaudeCodeAdapterLiveOptions {
  readonly runtime?: ClaudeCodeRuntime;
  readonly makeRuntime?: () => ClaudeCodeRuntime;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toSessionError(
  sessionId: ProviderSessionId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      sessionId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(
  sessionId: ProviderSessionId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(sessionId, cause);
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

function makeUnavailableRuntime(): ClaudeCodeRuntime {
  const unavailable = async (): Promise<never> => {
    throw new Error("Claude Code runtime is not configured.");
  };

  return {
    startSession: unavailable,
    sendTurn: unavailable,
    interruptTurn: unavailable,
    readThread: unavailable,
    rollbackThread: unavailable,
    respondToRequest: unavailable,
    stopSession: () => {},
    listSessions: () => [],
    hasSession: () => false,
    stopAll: () => {},
    streamEvents: Stream.empty,
  };
}

const makeClaudeCodeAdapter = (options?: ClaudeCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (options?.runtime) {
          return options.runtime;
        }
        if (options?.makeRuntime) {
          return options.makeRuntime();
        }
        return makeUnavailableRuntime();
      }),
      (runtime) =>
        Effect.sync(() => {
          try {
            runtime.stopAll();
          } catch {
            // Finalizers should never fail and block shutdown.
          }
        }),
    );

    const startSession: ClaudeCodeAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      return Effect.tryPromise({
        try: () => runtime.startSession(input),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            sessionId: "pending",
            detail: toMessage(cause, "Failed to start Claude Code adapter session."),
            cause,
          }),
      });
    };

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: () => runtime.sendTurn(input),
        catch: (cause) => toRequestError(input.sessionId, "turn/start", cause),
      });

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (sessionId, turnId) =>
      Effect.tryPromise({
        try: () => runtime.interruptTurn(sessionId, turnId),
        catch: (cause) => toRequestError(sessionId, "turn/interrupt", cause),
      });

    const readThread: ClaudeCodeAdapterShape["readThread"] = (sessionId) =>
      Effect.tryPromise({
        try: () => runtime.readThread(sessionId),
        catch: (cause) => toRequestError(sessionId, "thread/read", cause),
      });

    const rollbackThread: ClaudeCodeAdapterShape["rollbackThread"] = (sessionId, numTurns) => {
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
        try: () => runtime.rollbackThread(sessionId, numTurns),
        catch: (cause) => toRequestError(sessionId, "thread/rollback", cause),
      });
    };

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: () => runtime.respondToRequest(sessionId, requestId, decision),
        catch: (cause) => toRequestError(sessionId, "item/requestApproval/decision", cause),
      });

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (sessionId) =>
      Effect.sync(() => {
        runtime.stopSession(sessionId);
      });

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => runtime.listSessions());

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (sessionId) =>
      Effect.sync(() => runtime.hasSession(sessionId));

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        runtime.stopAll();
      });

    return {
      provider: PROVIDER,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: runtime.streamEvents,
    } satisfies ClaudeCodeAdapterShape;
  });

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter());

export function makeClaudeCodeAdapterLive(options?: ClaudeCodeAdapterLiveOptions) {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter(options));
}

