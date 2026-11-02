import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_ProjectionThreadsGoal.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadTurnQueue.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsActiveOrderKey.ts";
import Migration0044 from "./Migrations/044_ProjectionThreadMessageCorrections.ts";
import Migration0045 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0046 from "./Migrations/046_ProjectionThreadLinkedPullRequest.ts";
import Migration0047 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0048 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0049 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0050 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0051 from "./Migrations/047_ProjectionProjectIcon.ts";
// Upstream 048; renumbered to the next free fork id. Upstream's
// 049_ProjectionThreadsActiveOrderKey duplicates fork migration 43, so it is not
// re-registered here.
import Migration0052 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
// Upstream 050; renumbered to the next free fork id.
import Migration0053 from "./Migrations/050_ProjectionThreadPullRequests.ts";
// Upstream 051; renumbered to the next free fork id.
import Migration0054 from "./Migrations/051_ProjectionThreadMessageContext.ts";
// Upstream 052; renumbered to the next free fork id.
import Migration0055 from "./Migrations/052_ProjectionThreadTitleState.ts";
// Upstream 053 (PR #11215); renumbered to the next free fork id.
import Migration0056 from "./Migrations/053_ProjectionUsageLimitResume.ts";
// Upstream 053 (PR #11846); file renumbered to 055 and registered as the next free fork id.
import Migration0057 from "./Migrations/055_ProjectionThreadsAutoSettleDisabledAt.ts";
// Upstream 053 (PR #9124); file renumbered to 056 and registered as the next free fork id.
import Migration0058 from "./Migrations/056_ProjectionThreadsLastVisitedAt.ts";
// Fork migration for self-hosted push device registrations (ochen1 port).
import Migration0059 from "./Migrations/069_SelfHostedPushDevices.ts";
// Fork migration for native Pi lifecycle overrides (bdsqqq port).
import Migration0060 from "./Migrations/071_PiExternalLifecycleOverrides.ts";
// Fork-only: scheduled send time / recurrence on queued turns (KamiCode port).
import Migration0061 from "./Migrations/066_ProjectionThreadTurnQueueScheduledFor.ts";
import Migration0062 from "./Migrations/067_ProjectionThreadTurnQueueRecurrence.ts";
// Upstream 053 (PR #7721); registered as the next free fork id.
import Migration0063 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0064 from "./Migrations/055_OrchestrationV2.ts";
import Migration0065 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
// Upstream 057/058; registered as the next free fork ids.
import Migration0066 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0067 from "./Migrations/058_WebhookRelayDeliveries.ts";
// Upstream 059; registered as the next free fork id.
import Migration0068 from "./Migrations/059_McpAppModelContext.ts";
// Upstream 060; registered as the next free fork id.
import Migration0069 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
// Upstream 061 (PR review guides); registered as the next free fork id.
import Migration0070 from "./Migrations/061_PullRequestReviewGuides.ts";
// Upstream 062; registered as the next free fork id.
import Migration0071 from "./Migrations/062_ThreadFailureLookupIndex.ts";
// Upstream 063/064; registered as the next free fork ids.
import Migration0072 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0073 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
// Upstream 065; registered as the next free fork id.
import Migration0074 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
// Upstream 066 (repair client settlement timestamps); registered as the next free fork id.
import Migration0075 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
// Upstream 067 (webhook dedupe); registered as the next free fork id.
import Migration0076 from "./Migrations/067_WebhookDedupe.ts";
// Upstream 068/069; registered as the next free fork ids.
import Migration0077 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration0078 from "./Migrations/069_ThreadMessageSearch.ts";
// Upstream 070-072 (peer links); registered as the next free fork ids.
import Migration0079 from "./Migrations/070_PeerLinks.ts";
import Migration0080 from "./Migrations/071_PeerLinkFence.ts";
import Migration0081 from "./Migrations/072_WaitingLinkRequestIndex.ts";
// Upstream 073 (active turn item indexes); registered as the next free fork id.
import Migration0082 from "./Migrations/073_ActiveTurnItemIndexes.ts";
// Upstream 074-076 (search placeholders, subagent delivery state, project pin/archive);
// registered as the next free fork ids.
import Migration0083 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration0084 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration0085 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
// Upstream 077 (repair boolean settledOverride); registered as the next free fork id.
import Migration0086 from "./Migrations/077_RepairBooleanSettledOverride.ts";

const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "ProjectionThreadsGoal", Migration0041],
  [42, "ProjectionThreadTurnQueue", Migration0042],
  [43, "ProjectionThreadsActiveOrderKey", Migration0043],
  [44, "ProjectionThreadMessageCorrections", Migration0044],
  [45, "AuthSessionClientConnection", Migration0045],
  [46, "ProjectionThreadLinkedPullRequest", Migration0046],
  [47, "ProjectionThreadsUnsettledAt", Migration0047],
  [48, "ClearAutomaticProjectModelDefaults", Migration0048],
  [49, "ProjectionProjectsAutoPull", Migration0049],
  [50, "RepairAutomaticSettlementTimestamps", Migration0050],
  [51, "ProjectionProjectIcon", Migration0051],
  [52, "ProjectionThreadBranchPullRequest", Migration0052],
  [53, "ProjectionThreadPullRequests", Migration0053],
  [54, "ProjectionThreadMessageContext", Migration0054],
  [55, "ProjectionThreadTitleState", Migration0055],
  [56, "ProjectionUsageLimitResume", Migration0056],
  [57, "ProjectionThreadsAutoSettleDisabledAt", Migration0057],
  [58, "ProjectionThreadsLastVisitedAt", Migration0058],
  [59, "SelfHostedPushDevices", Migration0059],
  [60, "PiExternalLifecycleOverrides", Migration0060],
  [61, "ProjectionThreadTurnQueueScheduledFor", Migration0061],
  [62, "ProjectionThreadTurnQueueRecurrence", Migration0062],
  [63, "PullRequestFilesViewed", Migration0063],
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [64, "OrchestrationV2", Migration0064],
  [65, "RemoveRedundantProjectionIndexes", Migration0065],
  // Upstream 057/058 (webhook tasks, #15085/#15086); registered as the next free fork ids.
  [66, "ScheduledTaskWebhooks", Migration0066],
  [67, "WebhookRelayDeliveries", Migration0067],
  // Upstream 059 (MCP app model context); registered as the next free fork id.
  [68, "McpAppModelContext", Migration0068],
  [69, "ThreadSnapshotWindowIndexes", Migration0069],
  // Upstream 061 (PR review guides); registered as the next free fork id.
  [70, "PullRequestReviewGuides", Migration0070],
  // Upstream 062 (thread failure lookup index); registered as the next free fork id.
  [71, "ThreadFailureLookupIndex", Migration0071],
  // Upstream 063/064 (drop unused V1 projections, canonicalize thread PR links);
  // registered as the next free fork ids.
  [72, "DropUnusedV1Projections", Migration0072],
  [73, "CanonicalizeThreadPullRequestLinks", Migration0073],
  // Upstream 065 (Codex usage native turn index); registered as the next free fork id.
  [74, "CodexUsageNativeTurnIndex", Migration0074],
  // Upstream 066 (repair client settlement timestamps); registered as the next free fork id.
  [75, "RepairClientSettlementTimestamps", Migration0075],
  // Upstream 067 (webhook dedupe); registered as the next free fork id.
  [76, "WebhookDedupe", Migration0076],
  // Upstream 068/069 (shell stop request index, thread message search); next free fork ids.
  [77, "ShellStopRequestIndex", Migration0077],
  [78, "ThreadMessageSearch", Migration0078],
  // Upstream 070-072 (peer links); next free fork ids.
  [79, "PeerLinks", Migration0079],
  [80, "PeerLinkFence", Migration0080],
  [81, "WaitingLinkRequestIndex", Migration0081],
  // Upstream 073 (active turn item indexes); next free fork id.
  [82, "ActiveTurnItemIndexes", Migration0082],
  // Upstream 074-076; next free fork ids.
  [83, "ExcludeAttachmentPlaceholdersFromSearch", Migration0083],
  [84, "SubagentDeliveryState", Migration0084],
  [85, "ProjectionProjectsPinArchive", Migration0085],
  // Upstream 077 (repair boolean settledOverride); next free fork id.
  [86, "RepairBooleanSettledOverride", Migration0086],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// V2's schema migrations start at 64 after the legacy schema migrations.
// Fork: upstream's id is 55; the fork's own migrations run 55-63 before V2.
const FIRST_V2_MIGRATION_ID = 64;

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  const previewMigrations = includesV2 ? yield* reconcileV2PreviewMigration() : [];
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
