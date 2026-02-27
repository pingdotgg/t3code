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
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";

const PROVIDER = "claudeCode" as const;

export interface ClaudeCodeRuntime {
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, unknown>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, unknown>;
  readonly interruptTurn: (
    sessionId: ProviderSessionId,
    turnId?: ProviderTurnId,
  ) => Effect.Effect<void, unknown>;
  readonly readThread: (
    sessionId: ProviderSessionId,
  ) => Effect.Effect<ProviderThreadSnapshot, unknown>;
  readonly rollbackThread: (
    sessionId: ProviderSessionId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, unknown>;
  readonly respondToRequest: (
    sessionId: ProviderSessionId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, unknown>;
  readonly stopSession: (sessionId: ProviderSessionId) => Effect.Effect<void>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly hasSession: (sessionId: ProviderSessionId) => Effect.Effect<boolean>;
  readonly stopAll: () => Effect.Effect<void>;
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
  const unavailableDetail = "Claude Code runtime is not configured.";

  return {
    startSession: () =>
      Effect.fail(
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          sessionId: "pending",
          detail: unavailableDetail,
        }),
      ),
    sendTurn: (_input) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: unavailableDetail,
        }),
      ),
    interruptTurn: (_sessionId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/interrupt",
          detail: unavailableDetail,
        }),
      ),
    readThread: (_sessionId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/read",
          detail: unavailableDetail,
        }),
      ),
    rollbackThread: (_sessionId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: unavailableDetail,
        }),
      ),
    respondToRequest: (_sessionId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: unavailableDetail,
        }),
      ),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    stopAll: () => Effect.void,
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
      (runtime) => runtime.stopAll(),
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

      return runtime.startSession(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              sessionId: "pending",
              detail: toMessage(cause, "Failed to start Claude Code adapter session."),
              cause,
            }),
        ),
      );
    };

    const sendTurn: ClaudeCodeAdapterShape["sendTurn"] = (input) =>
      runtime
        .sendTurn(input)
        .pipe(Effect.mapError((cause) => toRequestError(input.sessionId, "turn/start", cause)));

    const interruptTurn: ClaudeCodeAdapterShape["interruptTurn"] = (sessionId, turnId) =>
      runtime
        .interruptTurn(sessionId, turnId)
        .pipe(Effect.mapError((cause) => toRequestError(sessionId, "turn/interrupt", cause)));

    const readThread: ClaudeCodeAdapterShape["readThread"] = (sessionId) =>
      runtime
        .readThread(sessionId)
        .pipe(Effect.mapError((cause) => toRequestError(sessionId, "thread/read", cause)));

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

      return runtime
        .rollbackThread(sessionId, numTurns)
        .pipe(Effect.mapError((cause) => toRequestError(sessionId, "thread/rollback", cause)));
    };

    const respondToRequest: ClaudeCodeAdapterShape["respondToRequest"] = (
      sessionId,
      requestId,
      decision,
    ) =>
      runtime
        .respondToRequest(sessionId, requestId, decision)
        .pipe(
          Effect.mapError((cause) =>
            toRequestError(sessionId, "item/requestApproval/decision", cause),
          ),
        );

    const stopSession: ClaudeCodeAdapterShape["stopSession"] = (sessionId) =>
      runtime.stopSession(sessionId);

    const listSessions: ClaudeCodeAdapterShape["listSessions"] = () => runtime.listSessions();

    const hasSession: ClaudeCodeAdapterShape["hasSession"] = (sessionId) =>
      runtime.hasSession(sessionId);

    const stopAll: ClaudeCodeAdapterShape["stopAll"] = () => runtime.stopAll();

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
