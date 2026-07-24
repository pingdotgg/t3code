/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
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
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Settle provider session runtime rows that an unclean shutdown left in a
   * live status.
   *
   * A freshly started process owns no provider children and no in-memory
   * sessions, so every runtime row not already marked `"stopped"` is stale: it
   * survived a crash, SIGKILL, or power loss that skipped the graceful-shutdown
   * finalizer. This rewrites those rows to `"stopped"` while preserving each
   * `resumeCursor`, mirroring the finalizer's persistence mutation so the next
   * user turn can still resume the provider conversation. Intended to run once
   * at boot, before reactors and the idle reaper start handling new work.
   */
  readonly reconcileStaleSessionsOnBoot: () => Effect.Effect<void>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
