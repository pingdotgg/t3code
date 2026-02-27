/**
 * ClaudeCodeAdapterLive - Scoped live implementation for the Claude Code provider adapter.
 *
 * Until the Claude runtime bridge is implemented, this adapter is wired
 * directly and returns typed "not configured" errors for runtime operations.
 *
 * @module ClaudeCodeAdapterLive
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterShape } from "../Services/ClaudeCodeAdapter.ts";

const PROVIDER = "claudeCode" as const;
const CLAUDE_RUNTIME_NOT_CONFIGURED = "Claude Code runtime is not configured.";

const makeClaudeCodeAdapter = Effect.succeed({
  provider: PROVIDER,
  startSession: (input) => {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        }),
      );
    }

    return Effect.fail(
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        sessionId: "pending",
        detail: CLAUDE_RUNTIME_NOT_CONFIGURED,
      }),
    );
  },
  sendTurn: (input) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `${CLAUDE_RUNTIME_NOT_CONFIGURED} (session ${input.sessionId})`,
      }),
    ),
  interruptTurn: (sessionId, _turnId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/interrupt",
        detail: `${CLAUDE_RUNTIME_NOT_CONFIGURED} (session ${sessionId})`,
      }),
    ),
  readThread: (sessionId) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/read",
        detail: `${CLAUDE_RUNTIME_NOT_CONFIGURED} (session ${sessionId})`,
      }),
    ),
  rollbackThread: (sessionId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: `${CLAUDE_RUNTIME_NOT_CONFIGURED} (session ${sessionId})`,
      }),
    );
  },
  respondToRequest: (sessionId, _requestId, _decision) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/requestApproval/decision",
        detail: `${CLAUDE_RUNTIME_NOT_CONFIGURED} (session ${sessionId})`,
      }),
    ),
  stopSession: (_sessionId) => Effect.void,
  listSessions: () => Effect.succeed([]),
  hasSession: (_sessionId) => Effect.succeed(false),
  stopAll: () => Effect.void,
  streamEvents: Stream.empty as Stream.Stream<ProviderRuntimeEvent>,
} satisfies ClaudeCodeAdapterShape);

export const ClaudeCodeAdapterLive = Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter);

export function makeClaudeCodeAdapterLive() {
  return Layer.effect(ClaudeCodeAdapter, makeClaudeCodeAdapter);
}
