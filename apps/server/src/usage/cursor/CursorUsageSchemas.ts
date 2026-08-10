/**
 * Wire schemas for Cursor's Admin API (`POST /teams/filtered-usage-events`).
 *
 * This targets the fields documented in the Cursor Admin API for team/business
 * accounts. Cursor's exact response shape is not pinned to a published
 * OpenAPI spec at the time of writing, so every field here is optional except
 * what the normalizer strictly needs (a request identity and a timestamp) -
 * an unrecognised or missing field degrades that event's data rather than
 * failing the whole page. Verify field names against Cursor's current Admin
 * API documentation if this stops matching production responses.
 *
 * @module CursorUsageSchemas
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CursorAdminUsageEvent = Schema.Struct({
  /** Present on most events; used as the stable event identity when available. */
  id: Schema.optional(Schema.String),
  /** Epoch milliseconds, or an ISO string depending on API version. */
  timestamp: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  user: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
      id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
    }),
  ),
  model: Schema.optional(Schema.String),
  /** e.g. "included" | "usage-based" | "on-demand"; mapped by the normalizer. */
  kind: Schema.optional(Schema.String),
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  /** Raw API-equivalent cost, in USD cents. */
  requestsCosts: Schema.optional(Schema.Number),
  /** What was actually charged, in USD cents. */
  totalCents: Schema.optional(Schema.Number),
  /** Present on session-connector events; folded into the synthetic id for extra uniqueness. */
  conversationId: Schema.optional(Schema.String),
});
export type CursorAdminUsageEvent = typeof CursorAdminUsageEvent.Type;

export const CursorAdminUsagePage = Schema.Struct({
  usageEvents: Schema.Array(CursorAdminUsageEvent).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Present when another page follows; absent/null on the last page. */
  nextPageCursor: Schema.optional(Schema.NullOr(Schema.String)),
  /** Some API versions signal totals instead of a cursor. */
  totalUsageEventsCount: Schema.optional(Schema.Number),
});
export type CursorAdminUsagePage = typeof CursorAdminUsagePage.Type;

export const decodeCursorAdminUsagePage = Schema.decodeUnknownEffect(CursorAdminUsagePage);

/**
 * Wire schema for Cursor's undocumented dashboard usage-events endpoint
 * (`POST /api/dashboard/get-filtered-usage-events`), the only usage source
 * available to individual (non-team) accounts. Reverse-engineered from the
 * cursor.com web dashboard's own network requests, not a published spec -
 * every field is optional for the same reason as `CursorAdminUsageEvent`.
 * Verify against the live endpoint if this stops matching.
 */
export const CursorSessionUsageEvent = Schema.Struct({
  /** Epoch milliseconds as a *string* (confirmed against a live response). */
  timestamp: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  model: Schema.optional(Schema.String),
  /** e.g. "USAGE_EVENT_KIND_INCLUDED_IN_PRO"; mapped by the normalizer. */
  kind: Schema.optional(Schema.String),
  requestsCosts: Schema.optional(Schema.Number),
  conversationId: Schema.optional(Schema.String),
  tokenUsage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.optional(Schema.Number),
      cacheWriteTokens: Schema.optional(Schema.Number),
      cacheReadTokens: Schema.optional(Schema.Number),
      totalCents: Schema.optional(Schema.Number),
    }),
  ),
});
export type CursorSessionUsageEvent = typeof CursorSessionUsageEvent.Type;

export const CursorSessionUsagePage = Schema.Struct({
  usageEventsDisplay: Schema.Array(CursorSessionUsageEvent).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  totalUsageEventsCount: Schema.optional(Schema.Number),
});
export type CursorSessionUsagePage = typeof CursorSessionUsagePage.Type;

export const decodeCursorSessionUsagePage = Schema.decodeUnknownEffect(CursorSessionUsagePage);

/** Flattens the nested session-event shape into the same shape the Admin API normalizer expects. */
export function sessionEventToAdminShape(event: CursorSessionUsageEvent): CursorAdminUsageEvent {
  return {
    timestamp: event.timestamp,
    model: event.model,
    kind: event.kind,
    requestsCosts: event.requestsCosts,
    conversationId: event.conversationId,
    inputTokens: event.tokenUsage?.inputTokens,
    outputTokens: event.tokenUsage?.outputTokens,
    cacheWriteTokens: event.tokenUsage?.cacheWriteTokens,
    cacheReadTokens: event.tokenUsage?.cacheReadTokens,
    totalCents: event.tokenUsage?.totalCents,
  };
}
