/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  CommandId,
  OrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

export type ProviderTurnIntentSelector =
  | {
      readonly kind: "exact";
      readonly eventSequence: number;
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "oldest-for-thread";
      readonly threadId: ThreadId;
    };

export interface CompleteProviderTurnIntentInput {
  readonly selector: ProviderTurnIntentSelector;
  readonly commandPolicy: "always" | "if-consumed" | "if-consumed-and-session-starting";
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  /** Persist a correlated projection settlement with the consumed intent. */
  readonly acknowledgement?: {
    readonly turnId: TurnId;
    readonly acknowledgedAt: string;
  };
}

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /** Persist process-local payload identity before any external side effect. */
  readonly registerProcessLocalCommand?: (input: {
    readonly commandId: CommandId;
    readonly fingerprint: string;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError>;

  /** Resolve an exact accepted outer receipt without replaying process-local work. */
  readonly findAcceptedProcessLocalCommand?: (input: {
    readonly commandId: CommandId;
    readonly fingerprint: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<
    Option.Option<{ readonly sequence: number }>,
    OrchestrationDispatchCommandError
  >;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to read. Defaults to the event
   *   store's page-bounded default; pass a higher value when the caller must
   *   read every event after the cursor (e.g. per-thread catch-up that filters
   *   a small subset out of a potentially larger global range).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Atomically consume a durable provider handoff and apply its correlated
   * lifecycle commands on the same serialized engine queue/SQL transaction.
   * This is an internal reactor API; public command dispatch is unchanged.
   */
  readonly completeProviderTurnIntent?: (
    input: CompleteProviderTurnIntentInput,
  ) => Effect.Effect<{ consumed: boolean }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * Acquire a hot domain-event subscription in the caller's scope.
   *
   * Unlike `streamDomainEvents`, acquisition registers the subscriber before
   * the returned effect completes. Startup consumers use this to buffer live
   * events before taking a durable replay cursor, closing the subscribe/replay
   * race.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    Stream.Stream<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /**
   * The latest sequence reflected in the engine's authoritative command read
   * model (0 if none). Used to gauge how far behind a resuming client is before
   * choosing between an incremental replay and a fresh projected snapshot.
   */
  readonly latestSequence: Effect.Effect<number, never, never>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
