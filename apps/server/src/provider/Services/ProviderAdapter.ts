/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ProviderApprovalDecision,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import type { Effect } from "effect";
import type { Stream } from "effect";

export interface ProviderThreadTurnSnapshot {
  readonly id: string;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderKind;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (sessionId: string, turnId?: string) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    sessionId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (sessionId: string) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (sessionId: string) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (sessionId: string) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    sessionId: string,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
