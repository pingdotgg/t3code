/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderEvent,
  ProviderGetCheckpointDiffInput,
  ProviderGetCheckpointDiffResult,
  ProviderInterruptTurnInput,
  ProviderListCheckpointsInput,
  ProviderListCheckpointsResult,
  ProviderRespondToRequestInput,
  ProviderRevertToCheckpointInput,
  ProviderRevertToCheckpointResult,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderServiceError } from "../Errors.ts";

export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (input: ProviderStopSessionInput) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * List checkpoints for a provider session.
   */
  readonly listCheckpoints: (
    input: ProviderListCheckpointsInput,
  ) => Effect.Effect<ProviderListCheckpointsResult, ProviderServiceError>;

  /**
   * Diff two checkpoints for a provider session.
   */
  readonly getCheckpointDiff: (
    input: ProviderGetCheckpointDiffInput,
  ) => Effect.Effect<ProviderGetCheckpointDiffResult, ProviderServiceError>;

  /**
   * Revert a provider session to a checkpoint.
   */
  readonly revertToCheckpoint: (
    input: ProviderRevertToCheckpointInput,
  ) => Effect.Effect<ProviderRevertToCheckpointResult, ProviderServiceError>;

  /**
   * Stop all provider sessions.
   */
  readonly stopAll: () => Effect.Effect<void, ProviderServiceError>;

  /**
   * Dispose provider resources (logs/listeners).
   */
  readonly dispose: () => Effect.Effect<void, ProviderServiceError>;

  /**
   * Subscribe to provider event stream.
   */
  readonly subscribeToEvents: (
    callback: (event: ProviderEvent) => void,
  ) => Effect.Effect<() => void, ProviderServiceError>;
}

/**
 * ProviderService - Context tag for provider orchestration.
 */
export class ProviderService extends ServiceMap.Service<ProviderService, ProviderServiceShape>()(
  "provider/ProviderService",
) {}
