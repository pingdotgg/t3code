/**
 * Notification contracts — the four kinds, the decided edge transports receive,
 * and the two closed enums that keep detection separate from policy.
 *
 * There is exactly one transition detector in T3 Code (the server-side
 * `NotificationReactor`); transports never see levels or raw shell fields, only
 * the decided edges declared here. Presentation strings travel with the edge so
 * a wording change lands in one place and two transports can never disagree
 * about what one turn was called.
 *
 * The split that matters:
 *
 * - **Detection verdicts** are decidable from domain facts alone and are
 *   recorded server-side. They are never pushed to a transport.
 * - **Transport outcomes** are decidable only from client facts (is that thread
 *   focused? is the setting on?) and are reported back by each transport to
 *   complete the audit row.
 *
 * @module notifications
 */
import * as Schema from "effect/Schema";

import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";

/**
 * Prefix of every notification identity key: `t3:notif:<threadId>:<kind>:<id>`.
 *
 * The trailing id is the `turnId` for terminal kinds and the request id for
 * attention kinds. `updatedAt` is banned as an identity input — see
 * `NotificationDecidedEdge`.
 */
export const NOTIFICATION_IDENTITY_PREFIX = "t3:notif";

/**
 * The complete set of notification kinds. Four, deliberately.
 *
 * "Snoozed thread raised its hand" is not a kind — it is snooze policy letting
 * one of these four through.
 */
export const NotificationKind = Schema.Literals([
  "turn-completed",
  "turn-failed",
  "approval-required",
  "user-input-required",
]);
export type NotificationKind = typeof NotificationKind.Type;

/**
 * Awareness phase of a thread, as derived by `resolveThreadAwarenessPhase`
 * (`@t3tools/shared/agentAwareness`). Recorded on both sides of an edge so
 * "why did this fire" is answerable from the row alone.
 *
 * The `stale` awareness phase is absent on purpose: it is a relay-side
 * presentation state, never something the reactor derives, so it can never
 * appear on an edge.
 */
export const NotificationThreadPhase = Schema.Literals([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
]);
export type NotificationThreadPhase = typeof NotificationThreadPhase.Type;

/**
 * What the reactor concluded about a candidate edge, from domain facts only.
 *
 * - `detected` — a real edge; this is the only verdict that reaches a transport.
 * - `baseline` — the edge cannot be proven against a state the reactor actually
 *   observed (first sighting of the thread, or a turn never seen running).
 *   Unknown baseline means silence, deliberately.
 * - `not-user-initiated` — a background/subagent turn completed. Only
 *   `turn-completed` is filtered this way; the other three kinds fire
 *   regardless of initiator.
 * - `already-notified` — a terminal edge for this `(threadId, turnId)` was
 *   already announced under some kind (`failed` beats `completed`).
 * - `duplicate-identity` — the identity key already has a row; replay is
 *   idempotent by construction.
 */
export const NotificationDetectionVerdict = Schema.Literals([
  "detected",
  "baseline",
  "not-user-initiated",
  "already-notified",
  "duplicate-identity",
]);
export type NotificationDetectionVerdict = typeof NotificationDetectionVerdict.Type;

/**
 * What a transport did with a decided edge, reported back to complete the row.
 *
 * `no-transport-connected` is the initial value: an edge detected while nothing
 * was listening is still recorded, so the outbox stays audit-complete. Policy
 * suppression is never a dedup mechanism — a suppressed edge is logged as
 * suppressed, never as delivered.
 */
export const NotificationTransportOutcome = Schema.Literals([
  "shown",
  "suppressed:focused",
  "suppressed:disabled",
  "no-transport-connected",
]);
export type NotificationTransportOutcome = typeof NotificationTransportOutcome.Type;

/**
 * A decided edge: what the reactor detected, in the shape transports consume.
 *
 * `identityKey` is `t3:notif:<threadId>:<kind>:<turnId | requestId>`.
 * `thread.updatedAt` is **banned** as an identity input and is therefore absent
 * from this struct: it is the last domain-event timestamp, not a write clock, so
 * two distinct rising edges can share one value (and get deduped away) while a
 * flapping request can mint a fresh one (and get re-announced past dedup). Turn
 * ids and request ids are the only honest identities.
 *
 * There is no `deepLink`: `environmentId` is a client-side concept in T3 Code, so
 * the server cannot build a thread route. Transports navigate with
 * `resolveThreadRouteTarget` and their own environment id.
 */
export const NotificationDecidedEdge = Schema.Struct({
  identityKey: TrimmedNonEmptyString,
  kind: NotificationKind,
  threadId: ThreadId,
  projectId: ProjectId,
  /**
   * The turn this edge belongs to: the turn that ended for terminal kinds, and
   * the turn a request was raised inside for attention kinds (`null` only when
   * the provider raised it outside any turn). It is therefore *not* a
   * discriminator — read `kind` for that.
   */
  turnId: Schema.NullOr(TurnId),
  /**
   * Set for attention kinds; `null` for terminal kinds. Usually an
   * `ApprovalRequestId`, falling back to the triggering activity's `EventId`
   * when the provider surfaced a request without a stable id.
   */
  requestId: Schema.NullOr(TrimmedNonEmptyString),
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  headline: TrimmedNonEmptyString,
  detail: Schema.NullOr(TrimmedNonEmptyString),
  /** The domain event that triggered detection — follow it for causation. */
  triggeringEventId: EventId,
  triggeringSequence: NonNegativeInt,
  previousPhase: Schema.NullOr(NotificationThreadPhase),
  nextPhase: Schema.NullOr(NotificationThreadPhase),
  detectedAt: IsoDateTime,
});
export type NotificationDecidedEdge = typeof NotificationDecidedEdge.Type;

// ── Transport surface (WS) ─────────────────────────────────────────────

/**
 * WS methods a notification transport uses. Two, symmetrical: receive decided
 * edges, report back what was done with them.
 */
export const NOTIFICATION_WS_METHODS = {
  subscribe: "notifications.subscribe",
  reportTransportOutcome: "notifications.reportTransportOutcome",
} as const;

/**
 * Cap on the reconnect-gap catch-up read, so a socket that dropped for an hour
 * cannot dump an hour of edges into someone's notification centre. Exceeding it
 * is not an error: the sidebar inbox is the while-you-were-away surface.
 */
export const NOTIFICATION_CATCH_UP_MAX_EDGES = 200;

export const NotificationSubscribeInput = Schema.Struct({
  /**
   * Highest `triggeringSequence` this transport already presented. Present only
   * to close a **reconnect gap inside one client session** — it is not a history
   * replay: a fresh subscription (field omitted) deliberately starts empty and
   * receives only edges detected while it is connected.
   *
   * A future "show me what I missed while away" behaviour must arrive as its own
   * named setting driving its own bounded drain, never as a side effect of
   * subscribing.
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the catch-up range has been emitted and
   * before live edges begin.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});
export type NotificationSubscribeInput = typeof NotificationSubscribeInput.Type;

export const NotificationStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("edge"),
    edge: NotificationDecidedEdge,
  }),
]);
export type NotificationStreamItem = typeof NotificationStreamItem.Type;

/** The transports that exist in v1. */
export const NotificationTransportName = Schema.Literals(["desktop", "web"]);
export type NotificationTransportName = typeof NotificationTransportName.Type;

/**
 * The outcomes a transport can report. A strict subset of
 * `NotificationTransportOutcome`: `no-transport-connected` is the server's
 * initial value and can never be *reported* — a transport reporting it has, by
 * definition, connected.
 */
export const NotificationReportedTransportOutcome = Schema.Literals([
  "shown",
  "suppressed:focused",
  "suppressed:disabled",
]);
export type NotificationReportedTransportOutcome = typeof NotificationReportedTransportOutcome.Type;

export const NotificationReportTransportOutcomeInput = Schema.Struct({
  identityKey: TrimmedNonEmptyString,
  transportName: NotificationTransportName,
  outcome: NotificationReportedTransportOutcome,
});
export type NotificationReportTransportOutcomeInput =
  typeof NotificationReportTransportOutcomeInput.Type;

/**
 * The row as it stands after the report. First outcome wins, so a transport that
 * lost the race sees the outcome the other transport recorded — never a silent
 * overwrite.
 */
export const NotificationTransportOutcomeReport = Schema.Struct({
  identityKey: TrimmedNonEmptyString,
  transportOutcome: NotificationTransportOutcome,
  transportName: Schema.NullOr(TrimmedNonEmptyString),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type NotificationTransportOutcomeReport = typeof NotificationTransportOutcomeReport.Type;

export class NotificationSubscribeError extends Schema.TaggedErrorClass<NotificationSubscribeError>()(
  "NotificationSubscribeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class NotificationReportTransportOutcomeError extends Schema.TaggedErrorClass<NotificationReportTransportOutcomeError>()(
  "NotificationReportTransportOutcomeError",
  {
    message: TrimmedNonEmptyString,
    identityKey: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
