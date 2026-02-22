/**
 * CodexService - Service interface for codex app-server session lifecycle and RPC.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for process, protocol, and session operations.
 *
 * @module CodexService
 */
import type {
  ProviderApprovalDecision,
  ProviderEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CodexServiceError } from "../Errors.ts";

export interface CodexThreadTurnSnapshot {
  readonly id: string;
  readonly items: ReadonlyArray<unknown>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexServiceShape {
  /**
   * Start a codex app-server-backed provider session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, CodexServiceError>;

  /**
   * Send a new turn to an active codex session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexServiceError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (
    sessionId: string,
    turnId?: string,
  ) => Effect.Effect<void, CodexServiceError>;

  /**
   * Read a thread snapshot (including turns).
   */
  readonly readThread: (sessionId: string) => Effect.Effect<CodexThreadSnapshot, CodexServiceError>;

  /**
   * Roll back a thread by N turns.
   */
  readonly rollbackThread: (
    sessionId: string,
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexServiceError>;

  /**
   * Respond to an interactive approval request from codex app-server.
   */
  readonly respondToRequest: (
    sessionId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexServiceError>;

  /**
   * Stop one session.
   */
  readonly stopSession: (sessionId: string) => Effect.Effect<void, CodexServiceError>;

  /**
   * List active sessions.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether session id is currently active.
   */
  readonly hasSession: (sessionId: string) => Effect.Effect<boolean>;

  /**
   * Stop all sessions.
   */
  readonly stopAll: () => Effect.Effect<void, CodexServiceError>;

  /**
   * Subscribe to provider events emitted by codex app-server.
   */
  readonly subscribeToEvents: (
    callback: (event: ProviderEvent) => void,
  ) => Effect.Effect<() => void, CodexServiceError>;
}

/**
 * CodexService - Context tag for codex session and RPC operations.
 */
export class CodexService extends ServiceMap.Service<CodexService, CodexServiceShape>()(
  "provider/CodexService",
) {}
