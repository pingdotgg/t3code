/**
 * Cursor usage tracking contract.
 *
 * Cursor's CLI does not write local session transcripts the way Claude and
 * Codex do, so its usage events are fetched from Cursor's API and persisted
 * server-side rather than scanned from disk on every read. The persisted
 * events are aggregated into `UsageBucket`s (see `usage.ts`) with
 * `provider: "cursor"`, so the existing usage summary/merge/UI pipeline
 * covers Cursor without a parallel dashboard. This module only carries what
 * that pipeline cannot express: raw per-event listing, manual sync, and CSV
 * export.
 *
 * @module cursorUsage
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageBillingKind, UsageDay } from "./usage.ts";

export const CursorUsageEventId = TrimmedNonEmptyString.pipe(Schema.brand("CursorUsageEventId"));
export type CursorUsageEventId = typeof CursorUsageEventId.Type;

/** One normalized Cursor usage event, as persisted and returned to clients. */
export const CursorUsageEvent = Schema.Struct({
  id: CursorUsageEventId,
  occurredAt: IsoDateTime,
  day: UsageDay,
  model: TrimmedNonEmptyString,
  usageType: UsageBillingKind,
  inputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  cacheWriteTokens: Schema.optional(NonNegativeInt),
  cacheReadTokens: Schema.optional(NonNegativeInt),
  totalTokens: Schema.optional(NonNegativeInt),
  rawCostCents: Schema.optional(Schema.Number),
  chargedCents: Schema.optional(Schema.Number),
});
export type CursorUsageEvent = typeof CursorUsageEvent.Type;

export const CursorUsageWindow = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /** IANA zone the client wants days bucketed and sorted in. */
  timeZone: TrimmedNonEmptyString,
});
export type CursorUsageWindow = typeof CursorUsageWindow.Type;

export const CursorUsageEventsInput = Schema.Struct({
  ...CursorUsageWindow.fields,
  /** Opaque pagination cursor from a prior page; absent for the first page. */
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(
    Schema.withDecodingDefault(Effect.succeed(100)),
  ),
});
export type CursorUsageEventsInput = typeof CursorUsageEventsInput.Type;

export const CursorUsageEventsPage = Schema.Struct({
  events: Schema.Array(CursorUsageEvent),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type CursorUsageEventsPage = typeof CursorUsageEventsPage.Type;

export const CursorUsageExportInput = CursorUsageWindow;
export type CursorUsageExportInput = typeof CursorUsageExportInput.Type;

export const CursorUsageExportResult = Schema.Struct({
  csv: Schema.String,
  rowCount: NonNegativeInt,
});
export type CursorUsageExportResult = typeof CursorUsageExportResult.Type;

export const CursorUsageSyncStatus = Schema.Literals(["ok", "partial", "notConfigured"]);
export type CursorUsageSyncStatus = typeof CursorUsageSyncStatus.Type;

export const CursorUsageSyncResult = Schema.Struct({
  status: CursorUsageSyncStatus,
  eventsFetched: NonNegativeInt,
  eventsInserted: NonNegativeInt,
  eventsDeduplicated: NonNegativeInt,
  lastSuccessfulSyncAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type CursorUsageSyncResult = typeof CursorUsageSyncResult.Type;

export const SetCursorUsageAdminApiKeyInput = Schema.Struct({
  /** `null` clears a previously configured key. */
  apiKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type SetCursorUsageAdminApiKeyInput = typeof SetCursorUsageAdminApiKeyInput.Type;

export const SetCursorUsageAdminApiKeyResult = Schema.Struct({
  configured: Schema.Boolean,
});
export type SetCursorUsageAdminApiKeyResult = typeof SetCursorUsageAdminApiKeyResult.Type;

/**
 * `sessionToken` is the value of the `WorkosCursorSessionToken` cookie set
 * when a user is signed in at cursor.com - the only way an individual
 * (non-team) account can authenticate against Cursor's undocumented
 * dashboard usage endpoint. It is stored the same way as the Admin API key
 * (`ServerSecretStore`, chmod 600, never echoed back to a client) and is
 * never sent anywhere except Cursor's own domain.
 */
export const SetCursorUsageSessionTokenInput = Schema.Struct({
  /** `null` clears a previously configured token. */
  sessionToken: Schema.NullOr(TrimmedNonEmptyString),
});
export type SetCursorUsageSessionTokenInput = typeof SetCursorUsageSessionTokenInput.Type;

export const SetCursorUsageSessionTokenResult = Schema.Struct({
  configured: Schema.Boolean,
});
export type SetCursorUsageSessionTokenResult = typeof SetCursorUsageSessionTokenResult.Type;

export const CursorUsageConnectionMode = Schema.Literals(["adminApi", "session", "none"]);
export type CursorUsageConnectionMode = typeof CursorUsageConnectionMode.Type;

export const CursorUsageStatus = Schema.Struct({
  configured: Schema.Boolean,
  connectionMode: CursorUsageConnectionMode,
  lastSuccessfulSyncAt: Schema.NullOr(IsoDateTime),
  backfillCompleted: Schema.Boolean,
});
export type CursorUsageStatus = typeof CursorUsageStatus.Type;

export class CursorUsageNotConfiguredError extends Schema.TaggedErrorClass<CursorUsageNotConfiguredError>()(
  "CursorUsageNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Cursor usage tracking requires a Cursor Admin API key or session token.";
  }
}

export class CursorUsageAuthError extends Schema.TaggedErrorClass<CursorUsageAuthError>()(
  "CursorUsageAuthError",
  {},
) {
  override get message(): string {
    return "Cursor usage authentication expired.";
  }
}

export class CursorUsageUnavailableError extends Schema.TaggedErrorClass<CursorUsageUnavailableError>()(
  "CursorUsageUnavailableError",
  {
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Cursor usage endpoint is currently unavailable: ${this.detail}`;
  }
}

export class CursorUsageRateLimitedError extends Schema.TaggedErrorClass<CursorUsageRateLimitedError>()(
  "CursorUsageRateLimitedError",
  {},
) {
  override get message(): string {
    return "Cursor usage temporarily rate limited.";
  }
}

export class CursorUsageReadError extends Schema.TaggedErrorClass<CursorUsageReadError>()(
  "CursorUsageReadError",
  {
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Cursor usage read failed: ${this.detail}`;
  }
}

export const CursorUsageError = Schema.Union([
  CursorUsageNotConfiguredError,
  CursorUsageAuthError,
  CursorUsageUnavailableError,
  CursorUsageRateLimitedError,
  CursorUsageReadError,
]);
export type CursorUsageError = typeof CursorUsageError.Type;
