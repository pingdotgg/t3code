/**
 * NotificationOutboxRepository - Repository interface for the notification outbox.
 *
 * The outbox is the audit record for notification detection: every candidate
 * edge the `NotificationReactor` forms gets a row, whether or not it was ever
 * shown. `identityKey` is the primary key, which is what makes replaying the
 * reactor from sequence 0 idempotent.
 *
 * @module NotificationOutboxRepository
 */
import {
  IsoDateTime,
  NonNegativeInt,
  NotificationDecidedEdge,
  NotificationDetectionVerdict,
  NotificationTransportOutcome,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

/**
 * One outbox row: a decided edge plus the audit columns that answer "why did
 * this fire / why didn't it".
 */
export const NotificationOutboxRecord = Schema.Struct({
  ...NotificationDecidedEdge.fields,
  detectionVerdict: NotificationDetectionVerdict,
  /** Short kebab-case name of the guard that produced `detectionVerdict`. */
  decidingGuard: TrimmedNonEmptyString,
  transportOutcome: NotificationTransportOutcome,
  /** Which transport claimed the row (`desktop`, `web`, …); null until claimed. */
  transportName: Schema.NullOr(TrimmedNonEmptyString),
  /** When a transport reported its outcome back. */
  completedAt: Schema.NullOr(IsoDateTime),
});
export type NotificationOutboxRecord = typeof NotificationOutboxRecord.Type;

export const GetNotificationOutboxRecordInput = Schema.Struct({
  identityKey: TrimmedNonEmptyString,
});
export type GetNotificationOutboxRecordInput = typeof GetNotificationOutboxRecordInput.Type;

export const FindTerminalNotificationInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export type FindTerminalNotificationInput = typeof FindTerminalNotificationInput.Type;

export const ListNotificationOutboxByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListNotificationOutboxByThreadInput = typeof ListNotificationOutboxByThreadInput.Type;

export const ListDecidedNotificationEdgesInput = Schema.Struct({
  /** Exclusive cursor over `triggeringSequence`. */
  afterSequence: NonNegativeInt,
  limit: NonNegativeInt,
});
export type ListDecidedNotificationEdgesInput = typeof ListDecidedNotificationEdgesInput.Type;

export const CompleteNotificationTransportOutcomeInput = Schema.Struct({
  identityKey: TrimmedNonEmptyString,
  transportOutcome: NotificationTransportOutcome,
  transportName: TrimmedNonEmptyString,
  completedAt: IsoDateTime,
});
export type CompleteNotificationTransportOutcomeInput =
  typeof CompleteNotificationTransportOutcomeInput.Type;

/** Narrows an audit row back to the payload transports consume. */
export function notificationDecidedEdgeFromRecord(
  record: NotificationOutboxRecord,
): NotificationDecidedEdge {
  return {
    identityKey: record.identityKey,
    kind: record.kind,
    threadId: record.threadId,
    projectId: record.projectId,
    turnId: record.turnId,
    requestId: record.requestId,
    projectTitle: record.projectTitle,
    threadTitle: record.threadTitle,
    headline: record.headline,
    detail: record.detail,
    triggeringEventId: record.triggeringEventId,
    triggeringSequence: record.triggeringSequence,
    previousPhase: record.previousPhase,
    nextPhase: record.nextPhase,
    detectedAt: record.detectedAt,
  };
}

/**
 * NotificationOutboxRepositoryShape - Service API for notification outbox rows.
 */
export interface NotificationOutboxRepositoryShape {
  /**
   * Insert a row, ignoring the insert when any uniqueness constraint already
   * holds (`identityKey`, or the terminal `(threadId, turnId)` index).
   *
   * Insert-or-ignore rather than upsert: a recorded decision is history, and
   * replaying the reactor must not rewrite it.
   */
  readonly insertIfAbsent: (
    row: NotificationOutboxRecord,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read one row by identity key.
   */
  readonly getByIdentityKey: (
    input: GetNotificationOutboxRecordInput,
  ) => Effect.Effect<Option.Option<NotificationOutboxRecord>, ProjectionRepositoryError>;

  /**
   * Read the terminal row already recorded for a turn, under either terminal
   * kind. Terminal kinds are mutually exclusive per turn.
   */
  readonly findTerminalByThreadTurn: (
    input: FindTerminalNotificationInput,
  ) => Effect.Effect<Option.Option<NotificationOutboxRecord>, ProjectionRepositoryError>;

  /**
   * Delete one row by identity key.
   *
   * The single caller is the reactor's "`failed` wins over `completed`" path
   * (SPEC §2): the two terminal kinds share a partial unique index over
   * `(threadId, turnId)`, so the recorded `turn-completed` row has to give up the
   * slot before the truer `turn-failed` row can take it. Nothing else deletes —
   * a decision that stands is history.
   */
  readonly deleteByIdentityKey: (
    input: GetNotificationOutboxRecordInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List every row for a thread in detection order. Audit surface.
   */
  readonly listByThreadId: (
    input: ListNotificationOutboxByThreadInput,
  ) => Effect.Effect<ReadonlyArray<NotificationOutboxRecord>, ProjectionRepositoryError>;

  /**
   * List rows whose verdict is `detected` after an exclusive
   * `triggeringSequence` cursor, oldest first.
   *
   * This is the catch-up read behind a cursor-resumable transport subscription:
   * only `detected` rows are deliverable, so suppressed candidates never leak to
   * a transport.
   */
  readonly listDecidedEdgesAfterSequence: (
    input: ListDecidedNotificationEdgesInput,
  ) => Effect.Effect<ReadonlyArray<NotificationOutboxRecord>, ProjectionRepositoryError>;

  /**
   * Complete a row with the outcome a transport reported back.
   *
   * Only ever moves a row off `no-transport-connected`; a row already claimed by
   * a transport keeps its first outcome, so a second transport cannot overwrite
   * "shown" with "suppressed" or vice versa.
   */
  readonly completeTransportOutcome: (
    input: CompleteNotificationTransportOutcomeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * NotificationOutboxRepository - Service tag for notification outbox persistence.
 */
export class NotificationOutboxRepository extends Context.Service<
  NotificationOutboxRepository,
  NotificationOutboxRepositoryShape
>()("t3/persistence/Services/NotificationOutbox/NotificationOutboxRepository") {}
