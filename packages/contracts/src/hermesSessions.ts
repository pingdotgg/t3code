import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MIN_HERMES_SESSION_IMPORT_AGE_DAYS = 1;
export const MAX_HERMES_SESSION_IMPORT_AGE_DAYS = 30;
export const DEFAULT_HERMES_SESSION_IMPORT_AGE_DAYS = 1;
export const HermesSessionImportAgeDays = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_HERMES_SESSION_IMPORT_AGE_DAYS,
    maximum: MAX_HERMES_SESSION_IMPORT_AGE_DAYS,
  }),
);
export type HermesSessionImportAgeDays = typeof HermesSessionImportAgeDays.Type;

export const HermesSessionImportSelection = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("recent"),
    limit: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("selected"),
    sessionIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("all"),
  }),
]);
export type HermesSessionImportSelection = typeof HermesSessionImportSelection.Type;

export const HermesSessionDiscoveryInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  limit: Schema.optional(Schema.Number),
});
export type HermesSessionDiscoveryInput = typeof HermesSessionDiscoveryInput.Type;

export const HermesDiscoveredSession = Schema.Struct({
  storedSessionId: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  startedAt: Schema.Number,
  settlement: Schema.Literals(["unsettled", "settled"]),
  messageCount: Schema.Number,
  source: Schema.String,
  importedThreadId: Schema.NullOr(ThreadId),
});
export type HermesDiscoveredSession = typeof HermesDiscoveredSession.Type;

export const HermesSessionImportCapabilities = Schema.Struct({
  discovery: Schema.Boolean,
  lazyHistory: Schema.Boolean,
  transportSources: Schema.Array(Schema.String),
  activityTimestamp: Schema.Struct({
    field: Schema.Literal("started_at"),
    limitation: Schema.String,
  }),
  childSessionLineage: Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
  }),
  copyChildSession: Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
  }),
});
export type HermesSessionImportCapabilities = typeof HermesSessionImportCapabilities.Type;

export const HermesSessionDiscoveryResult = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  profileKey: Schema.String,
  sessions: Schema.Array(HermesDiscoveredSession),
  capabilities: HermesSessionImportCapabilities,
  mainThreadId: Schema.NullOr(ThreadId),
});
export type HermesSessionDiscoveryResult = typeof HermesSessionDiscoveryResult.Type;

export const HermesSessionImportInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  /**
   * Internal orchestration attachment only. Hermes Work remains projectless
   * in the product model and UI; this ID is not sent to Hermes.
   */
  backingProjectId: ProjectId,
  selection: HermesSessionImportSelection,
  activeWithinDays: HermesSessionImportAgeDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_HERMES_SESSION_IMPORT_AGE_DAYS)),
  ),
  ensureMain: Schema.optional(Schema.Boolean),
});
export type HermesSessionImportInput = typeof HermesSessionImportInput.Type;

export const HermesSessionImportItem = Schema.Struct({
  storedSessionId: Schema.String,
  threadId: ThreadId,
  settlement: Schema.Literals(["unsettled", "settled"]),
  status: Schema.Literals(["imported", "already_imported"]),
});
export type HermesSessionImportItem = typeof HermesSessionImportItem.Type;

export const HermesSessionImportResult = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  profileKey: Schema.String,
  imported: Schema.Array(HermesSessionImportItem),
  mainThreadId: Schema.NullOr(ThreadId),
  capabilities: HermesSessionImportCapabilities,
});
export type HermesSessionImportResult = typeof HermesSessionImportResult.Type;

export const HermesHistoryResetInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  backingProjectId: ProjectId,
  operationId: Schema.String,
});
export type HermesHistoryResetInput = typeof HermesHistoryResetInput.Type;

export const HermesHistoryResetResult = Schema.Struct({
  deletedThreadCount: Schema.Number,
  clearedImportCount: Schema.Number,
});
export type HermesHistoryResetResult = typeof HermesHistoryResetResult.Type;

export class HermesSessionsError extends Schema.TaggedErrorClass<HermesSessionsError>()(
  "HermesSessionsError",
  {
    code: Schema.Literals([
      "provider_not_found",
      "provider_not_hermes",
      "provider_not_configured",
      "gateway_error",
      "import_failed",
      "history_reset_failed",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
