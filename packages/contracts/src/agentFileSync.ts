import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentFileSyncScope = Schema.Struct({ cwd: Schema.optionalKey(TrimmedNonEmptyString) });
export type AgentFileSyncScope = typeof AgentFileSyncScope.Type;
const LimitedText = Schema.String.check(Schema.isMaxLength(1_400_000));
const SyncPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const AgentFileSyncFile = Schema.Struct({
  path: SyncPath,
  data: LimitedText,
  mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 511 })),
});
export type AgentFileSyncFile = typeof AgentFileSyncFile.Type;
export const AgentFileSyncSection = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  contents: LimitedText,
});
export type AgentFileSyncSection = typeof AgentFileSyncSection.Type;
export const AgentFileSyncResource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("skill"),
    path: SyncPath,
    files: Schema.Array(AgentFileSyncFile).check(Schema.isMaxLength(256)),
  }),
  Schema.Struct({
    kind: Schema.Literal("instructions"),
    path: SyncPath,
    sections: Schema.Array(AgentFileSyncSection).check(Schema.isMaxLength(100)),
  }),
]);
export type AgentFileSyncResource = typeof AgentFileSyncResource.Type;
export const AgentFileSyncBundle = Schema.Array(AgentFileSyncResource).check(
  Schema.isMaxLength(120),
);
export type AgentFileSyncBundle = typeof AgentFileSyncBundle.Type;
export const AgentFileSyncCatalog = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
  instructions: Schema.Array(
    Schema.Struct({ path: Schema.String, sections: Schema.Array(AgentFileSyncSection) }),
  ),
  warnings: Schema.Array(Schema.String),
});
export type AgentFileSyncCatalog = typeof AgentFileSyncCatalog.Type;
export const AgentFileSyncExportInput = Schema.Struct({
  ...AgentFileSyncScope.fields,
  skills: Schema.Array(SyncPath).check(Schema.isMaxLength(100)),
  instructions: Schema.Array(
    Schema.Struct({ path: SyncPath, sectionIds: Schema.Array(Schema.String) }),
  ).check(Schema.isMaxLength(20)),
});
export type AgentFileSyncExportInput = typeof AgentFileSyncExportInput.Type;
export const AgentFileSyncPreviewInput = Schema.Struct({
  ...AgentFileSyncScope.fields,
  bundle: AgentFileSyncBundle,
});
export type AgentFileSyncPreviewInput = typeof AgentFileSyncPreviewInput.Type;
export const AgentFileSyncChange = Schema.Struct({
  path: Schema.String,
  revision: Schema.NullOr(Schema.String),
  changed: Schema.Boolean,
  before: Schema.String,
  after: Schema.String,
});
export const AgentFileSyncPreview = Schema.Array(AgentFileSyncChange);
export type AgentFileSyncPreview = typeof AgentFileSyncPreview.Type;
export const AgentFileSyncApplyInput = Schema.Struct({
  ...AgentFileSyncPreviewInput.fields,
  expected: Schema.Array(
    Schema.Struct({ path: Schema.String, revision: Schema.NullOr(Schema.String) }),
  ),
});
export type AgentFileSyncApplyInput = typeof AgentFileSyncApplyInput.Type;
export const AgentFileSyncApplyResult = Schema.Struct({
  undoId: Schema.NullOr(Schema.String),
  paths: Schema.Array(Schema.String),
  failures: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
});
export type AgentFileSyncApplyResult = typeof AgentFileSyncApplyResult.Type;
export const AgentFileSyncUndoInput = Schema.Struct({
  undoId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
});
export class AgentFileSyncError extends Schema.TaggedError<AgentFileSyncError>()(
  "AgentFileSyncError",
  {
    reason: Schema.Literals([
      "invalid-path",
      "limit",
      "subscription-limit",
      "unreadable-state",
      "linked-destination",
      "changed",
      "changed-backup",
      "recovery",
      "invalid-block",
      "io",
      "overlap",
    ]),
    path: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const at = this.path ? ` (${this.path})` : "";
    switch (this.reason) {
      case "invalid-path":
        return `This path is not a supported skill or instruction file${at}.`;
      case "limit":
        return `Selection exceeds the sync limit: 4 MB, 256 files per skill, 1 MB per file${at}.`;
      case "subscription-limit":
        return "This destination already has 20 sync subscriptions. Stop one before starting another.";
      case "unreadable-state":
        return "Saved sync subscriptions could not be read. Restore access and restart this environment before changing sync.";
      case "linked-destination":
        return `Destination contains a link or special file. Manage it on that host before syncing${at}.`;
      case "changed":
        return `Files changed since the preview or sync. Review them again${at}.`;
      case "changed-backup":
        return `Sync stopped with a preserved file backup${at}. Review it alongside the destination before resuming.`;
      case "recovery":
        return `Sync setup needs recovery. An undo receipt is retained${at}; review the destination and saved subscription before retrying undo.`;
      case "invalid-block":
        return `Instruction sync markers are incomplete or duplicated${at}.`;
      case "overlap":
        return "These destination files already belong to a sync subscription. Stop it before starting another.";
      case "io":
        return `Could not read or write sync files${at}.`;
    }
  }
}

const SyncId = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const AgentFileSyncSubscribeInput = Schema.Struct({
  ...AgentFileSyncApplyInput.fields,
  sourceEnvironmentId: EnvironmentId,
  selection: AgentFileSyncExportInput,
  label: TrimmedNonEmptyString,
});
export type AgentFileSyncSubscribeInput = typeof AgentFileSyncSubscribeInput.Type;
export const AgentFileSyncLink = Schema.Struct({
  id: SyncId,
  scope: AgentFileSyncScope,
  sourceEnvironmentId: EnvironmentId,
  selection: AgentFileSyncExportInput,
  label: Schema.String,
  paused: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.Number,
  generation: Schema.Int,
  revision: Schema.String,
});
export type AgentFileSyncLink = typeof AgentFileSyncLink.Type;
export const AgentFileSyncLinks = Schema.Array(AgentFileSyncLink);
export const AgentFileSyncRefreshInput = Schema.Struct({
  id: SyncId,
  generation: Schema.Int,
  bundle: Schema.NullOr(AgentFileSyncBundle),
});
export type AgentFileSyncRefreshInput = typeof AgentFileSyncRefreshInput.Type;
export const AgentFileSyncManageInput = Schema.Struct({
  id: SyncId,
  generation: Schema.optionalKey(Schema.Int),
  action: Schema.Literals(["pause", "resume", "remove"]),
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});
export type AgentFileSyncManageInput = typeof AgentFileSyncManageInput.Type;

export const AgentFileSyncCheckInput = Schema.Struct({
  selection: AgentFileSyncExportInput,
  revision: Schema.String,
});
export const AgentFileSyncCheckResult = Schema.Struct({
  bundle: Schema.NullOr(AgentFileSyncBundle),
});
