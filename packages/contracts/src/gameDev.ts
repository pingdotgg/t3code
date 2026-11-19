import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Game Development: editors Continuum installs, opens, and controls through a bridge plugin
 * that runs inside the editor, plus asset tools (Blender, ForgeGUI) that work with or without
 * an engine. Adding an engine (Godot, say) means a new id here and an adapter entry in
 * `@t3tools/shared/gameDevCatalog`; the workspace, RPCs, and agent tools stay the same.
 */
export const GameEngineId = Schema.Literals(["roblox", "unity", "unreal"]);
export type GameEngineId = typeof GameEngineId.Type;

export const GameAssetToolId = Schema.Literals(["blender", "forgegui"]);
export type GameAssetToolId = typeof GameAssetToolId.Type;

export const GameInstallTarget = Schema.Literals([
  "roblox",
  "unity",
  "unity-hub",
  "unreal",
  "epic-launcher",
  "blender",
]);
export type GameInstallTarget = typeof GameInstallTarget.Type;

/** `remote-only`: no editor build for this OS; run it on another machine that has Continuum. */
export const GameEngineAvailability = Schema.Literals(["local", "remote-only", "unsupported"]);
export type GameEngineAvailability = typeof GameEngineAvailability.Type;

export const GameInstallSource = Schema.Literals(["detected", "located", "managed"]);
export type GameInstallSource = typeof GameInstallSource.Type;

export const GameEngineInstall = Schema.Struct({
  target: GameInstallTarget,
  version: Schema.String,
  /** The editor (or tool) executable. */
  path: Schema.String,
  source: GameInstallSource,
});
export type GameEngineInstall = typeof GameEngineInstall.Type;

export const GameInstallerKind = Schema.Literals([
  /** Continuum downloads the vendor's installer and starts it. */
  "download-and-run",
  /** Continuum downloads a disk image or archive and opens it for the user. */
  "download-and-open",
  /** Continuum downloads and unpacks a portable build into its own tools folder. */
  "download-and-extract",
  /** The OS package manager installs it; Continuum shows the commands. */
  "package-manager",
  /** The vendor's launcher installs editor versions after sign-in. */
  "vendor-launcher",
  /** Only the vendor's website can hand out this download (sign-in or license). */
  "browser-handoff",
  "unavailable",
]);
export type GameInstallerKind = typeof GameInstallerKind.Type;

export const GameInstallerPlan = Schema.Struct({
  target: GameInstallTarget,
  kind: GameInstallerKind,
  title: Schema.String,
  version: Schema.NullOr(Schema.String),
  /** Where the bytes come from, shown before anything downloads. */
  source: Schema.String,
  url: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  sha256: Schema.NullOr(Schema.String),
  /** Commands for `package-manager` plans; Continuum never runs them with elevation. */
  commands: Schema.Array(Schema.String),
  /** Sign-in, license, and administrator steps the user has to take. */
  steps: Schema.Array(Schema.String),
  requiresAdmin: Schema.Boolean,
  requiresSignIn: Schema.Boolean,
  /** False when the vendor does not support this OS and the route is best effort. */
  official: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
});
export type GameInstallerPlan = typeof GameInstallerPlan.Type;

export const GamePlayState = Schema.Literals(["edit", "playing", "paused", "unknown"]);
export type GamePlayState = typeof GamePlayState.Type;

export const GameBridgeSessionState = Schema.Literals(["connected", "reloading", "disconnected"]);
export type GameBridgeSessionState = typeof GameBridgeSessionState.Type;

export const GameBridgeSession = Schema.Struct({
  sessionId: Schema.String,
  engine: GameEngineId,
  editorVersion: Schema.String,
  pluginVersion: Schema.String,
  /** Null until the user binds a Roblox place to a project; Unity and Unreal report it. */
  projectRoot: Schema.NullOr(Schema.String),
  projectName: Schema.String,
  state: GameBridgeSessionState,
  playState: GamePlayState,
  /** Operations this adapter advertised at connect time, such as `scene.tree`. */
  operations: Schema.Array(Schema.String),
  connectedAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  compileErrorCount: NonNegativeInt,
});
export type GameBridgeSession = typeof GameBridgeSession.Type;

export const GameEngineStatus = Schema.Struct({
  engine: GameEngineId,
  displayName: Schema.String,
  availability: GameEngineAvailability,
  availabilityReason: Schema.String,
  installs: Schema.Array(GameEngineInstall),
  /** Unity Hub or the Epic Games Launcher, when the engine installs through one. */
  launcher: Schema.NullOr(GameEngineInstall),
  recommendedVersion: Schema.NullOr(Schema.String),
  recommendedVersionSource: Schema.NullOr(Schema.String),
  installer: GameInstallerPlan,
  launcherInstaller: Schema.NullOr(GameInstallerPlan),
  /** What Continuum can do in this editor, in the user's words. */
  controls: Schema.Array(Schema.String),
  /** How the editor appears next to Continuum. */
  surface: Schema.Literals(["managed-window", "remote-machine"]),
  sessions: Schema.Array(GameBridgeSession),
});
export type GameEngineStatus = typeof GameEngineStatus.Type;

export const GameAssetToolStatus = Schema.Struct({
  tool: GameAssetToolId,
  displayName: Schema.String,
  installed: Schema.NullOr(GameEngineInstall),
  installer: Schema.NullOr(GameInstallerPlan),
  /** ForgeGUI: an API key is stored. Its value never leaves the server. */
  configured: Schema.Boolean,
  detail: Schema.String,
});
export type GameAssetToolStatus = typeof GameAssetToolStatus.Type;

export const GameDevSettings = Schema.Struct({
  bridgePort: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 })),
  /** Agents may move the editor camera to frame what they changed before a capture. */
  allowCameraControl: Schema.Boolean,
  /** Agents may upload to Roblox through ForgeGUI after each upload is approved. */
  allowForgeGuiPublishing: Schema.Boolean,
});
export type GameDevSettings = typeof GameDevSettings.Type;
export const DEFAULT_GAME_DEV_SETTINGS: GameDevSettings = {
  bridgePort: 47_321,
  allowCameraControl: true,
  allowForgeGuiPublishing: false,
};

export const GameApprovalRequest = Schema.Struct({
  approvalId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  projectRoot: Schema.NullOr(Schema.String),
  operation: Schema.String,
  summary: Schema.String,
  requestedAt: IsoDateTime,
  threadId: Schema.NullOr(Schema.String),
});
export type GameApprovalRequest = typeof GameApprovalRequest.Type;

export const GameDevOverview = Schema.Struct({
  host: Schema.Struct({
    platform: Schema.String,
    arch: Schema.String,
    label: Schema.String,
  }),
  bridge: Schema.Struct({
    port: Schema.Int,
    listening: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
  }),
  engines: Schema.Array(GameEngineStatus),
  tools: Schema.Array(GameAssetToolStatus),
  approvals: Schema.Array(GameApprovalRequest),
  settings: GameDevSettings,
});
export type GameDevOverview = typeof GameDevOverview.Type;

export const GameProject = Schema.Struct({
  engine: GameEngineId,
  root: Schema.String,
  name: Schema.String,
  /** `.uproject`, `ProjectSettings/ProjectVersion.txt`, a place file, or a Rojo project. */
  projectFile: Schema.NullOr(Schema.String),
  pinnedVersion: Schema.NullOr(Schema.String),
  /** Unity's changeset, which Unity Hub needs to install the exact editor. */
  pinnedRevision: Schema.NullOr(Schema.String),
  bridgeInstalled: Schema.Boolean,
});
export type GameProject = typeof GameProject.Type;

export const GameInstallEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("plan"), plan: GameInstallerPlan }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: Schema.Literals(["downloading", "verifying", "extracting", "starting"]),
    completedBytes: Schema.NullOr(Schema.Number),
    totalBytes: Schema.NullOr(Schema.Number),
    /** True when a previous partial download was continued instead of restarted. */
    resumed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("handoff"),
    message: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("complete"), message: Schema.String }),
]);
export type GameInstallEvent = typeof GameInstallEvent.Type;

export const GameDevInstallInput = Schema.Struct({
  target: GameInstallTarget,
  /** An engine version for Unity Hub to install; omitted for launchers and Blender. */
  version: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
});
export type GameDevInstallInput = typeof GameDevInstallInput.Type;

export const GameDevLocateInput = Schema.Struct({
  target: GameInstallTarget,
  path: TrimmedNonEmptyString,
});
export type GameDevLocateInput = typeof GameDevLocateInput.Type;

export const GameDevDetectProjectsInput = Schema.Struct({ root: TrimmedNonEmptyString });
export type GameDevDetectProjectsInput = typeof GameDevDetectProjectsInput.Type;

export const GameDevOpenProjectInput = Schema.Struct({
  engine: GameEngineId,
  projectRoot: TrimmedNonEmptyString,
  /** The editor to open with; the install matching the project's pinned version by default. */
  editorPath: Schema.optionalKey(Schema.String),
  /** Opening with a newer editor than the project's pinned version upgrades the project. */
  confirmUpgrade: Schema.optionalKey(Schema.Boolean),
});
export type GameDevOpenProjectInput = typeof GameDevOpenProjectInput.Type;

export const GameDevOpenProjectResult = Schema.Struct({
  launched: Schema.Boolean,
  editorVersion: Schema.String,
  bridgeInstalledAt: Schema.Array(Schema.String),
  /** Set when the editor is newer than the pinned version and no upgrade was confirmed. */
  upgradeRequired: Schema.NullOr(
    Schema.Struct({ from: Schema.String, to: Schema.String, message: Schema.String }),
  ),
  message: Schema.String,
});
export type GameDevOpenProjectResult = typeof GameDevOpenProjectResult.Type;

export const GameDevBindSessionInput = Schema.Struct({
  sessionId: Schema.String,
  projectRoot: TrimmedNonEmptyString,
});
export type GameDevBindSessionInput = typeof GameDevBindSessionInput.Type;

export const GameDevSettingsPatch = Schema.Struct({
  bridgePort: Schema.optionalKey(GameDevSettings.fields.bridgePort),
  allowCameraControl: Schema.optionalKey(Schema.Boolean),
  allowForgeGuiPublishing: Schema.optionalKey(Schema.Boolean),
});
export type GameDevSettingsPatch = typeof GameDevSettingsPatch.Type;

export const GameTimelineKind = Schema.Literals([
  "agent-action",
  "user-action",
  "log",
  "warning",
  "error",
  "build-error",
  "test-result",
  "capture",
  "play-state",
  "connection",
  "asset",
  "checkpoint",
]);
export type GameTimelineKind = typeof GameTimelineKind.Type;

export const GameTimelineEntry = Schema.Struct({
  id: Schema.String,
  at: IsoDateTime,
  kind: GameTimelineKind,
  text: Schema.String,
  /** Monotonic per playtest; null outside one. */
  playtest: Schema.NullOr(NonNegativeInt),
  captureId: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(Schema.String),
  ok: Schema.NullOr(Schema.Boolean),
});
export type GameTimelineEntry = typeof GameTimelineEntry.Type;

export const GameCompileMessage = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Int),
});
export type GameCompileMessage = typeof GameCompileMessage.Type;

export const GameCheckpointFile = Schema.Struct({
  path: Schema.String,
  bytes: NonNegativeInt,
  sha256: Schema.String,
});

export const GameCheckpoint = Schema.Struct({
  checkpointId: Schema.String,
  projectRoot: Schema.String,
  engine: GameEngineId,
  label: Schema.String,
  createdAt: IsoDateTime,
  createdBy: Schema.Literals(["agent", "user"]),
  /** The folders and globs it covers, in the user's words. */
  covers: Schema.Array(Schema.String),
  fileCount: NonNegativeInt,
  totalBytes: NonNegativeInt,
  /** Instances captured through the Roblox bridge (scripts and their properties). */
  instanceCount: NonNegativeInt,
  skipped: Schema.Array(Schema.String),
});
export type GameCheckpoint = typeof GameCheckpoint.Type;

export const GameCheckpointChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["modified", "added", "deleted"]),
  /** Unified diff for text files under the size limit. */
  diff: Schema.NullOr(Schema.String),
});
export type GameCheckpointChange = typeof GameCheckpointChange.Type;

export const GameCheckpointDiff = Schema.Struct({
  checkpoint: GameCheckpoint,
  changes: Schema.Array(GameCheckpointChange),
});
export type GameCheckpointDiff = typeof GameCheckpointDiff.Type;

export const GameDevWorkspaceInput = Schema.Struct({ projectRoot: TrimmedNonEmptyString });
export type GameDevWorkspaceInput = typeof GameDevWorkspaceInput.Type;

export const GameDevWorkspace = Schema.Struct({
  projectRoot: Schema.String,
  projects: Schema.Array(GameProject),
  session: Schema.NullOr(GameBridgeSession),
  /** Sessions connected but not bound to any project, such as a newly opened Roblox place. */
  unboundSessions: Schema.Array(GameBridgeSession),
  timeline: Schema.Array(GameTimelineEntry),
  compileMessages: Schema.Array(GameCompileMessage),
  latestCaptureId: Schema.NullOr(Schema.String),
  checkpoints: Schema.Array(GameCheckpoint),
  approvals: Schema.Array(GameApprovalRequest),
  playtestCount: NonNegativeInt,
});
export type GameDevWorkspace = typeof GameDevWorkspace.Type;

export const GameDevCommandInput = Schema.Struct({
  sessionId: Schema.String,
  operation: TrimmedNonEmptyString,
  args: Schema.Record(Schema.String, Schema.Unknown),
});
export type GameDevCommandInput = typeof GameDevCommandInput.Type;

export const GameDevCommandResult = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.Unknown,
  error: Schema.NullOr(Schema.String),
  captureId: Schema.NullOr(Schema.String),
});
export type GameDevCommandResult = typeof GameDevCommandResult.Type;

export const GameDevCaptureInput = Schema.Struct({ captureId: TrimmedNonEmptyString });
export const GameDevCapture = Schema.Struct({
  captureId: Schema.String,
  mimeType: Schema.String,
  dataBase64: Schema.String,
  width: Schema.NullOr(Schema.Int),
  height: Schema.NullOr(Schema.Int),
  at: IsoDateTime,
  source: Schema.Literals(["editor", "window", "blender", "forgegui", "file"]),
});
export type GameDevCapture = typeof GameDevCapture.Type;

export const GameDevResolveApprovalInput = Schema.Struct({
  approvalId: Schema.String,
  approve: Schema.Boolean,
});
export type GameDevResolveApprovalInput = typeof GameDevResolveApprovalInput.Type;

export const GameDevCheckpointCreateInput = Schema.Struct({
  projectRoot: TrimmedNonEmptyString,
  label: Schema.String,
  /** Project-relative folders or files; the engine's defaults when omitted. */
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GameDevCheckpointCreateInput = typeof GameDevCheckpointCreateInput.Type;

export const GameDevCheckpointRefInput = Schema.Struct({
  projectRoot: TrimmedNonEmptyString,
  checkpointId: TrimmedNonEmptyString,
});
export type GameDevCheckpointRefInput = typeof GameDevCheckpointRefInput.Type;

// Assets ------------------------------------------------------------------------------------

export const GameAssetKind = Schema.Literals(["model", "texture", "ui", "icon", "other"]);
export type GameAssetKind = typeof GameAssetKind.Type;

export const GameAssetDimensions = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  z: Schema.Number,
  /** `m`, `cm`, `studs`, or `px` for 2D art (z is then 0). */
  units: Schema.String,
});
export type GameAssetDimensions = typeof GameAssetDimensions.Type;

/** What the user asked for, kept with each revision so checks can hold the asset to it. */
export const GameAssetBrief = Schema.Struct({
  description: Schema.String,
  style: Schema.String,
  dimensions: Schema.NullOr(GameAssetDimensions),
  textureResolution: Schema.NullOr(Schema.Int),
  polygonBudget: Schema.NullOr(Schema.Int),
  /** Project-relative paths of reference images the user attached. */
  referenceImages: Schema.Array(Schema.String),
  targetEngine: Schema.NullOr(GameEngineId),
});
export type GameAssetBrief = typeof GameAssetBrief.Type;

export const GameAssetFileRole = Schema.Literals([
  "source",
  "export",
  "preview",
  "texture",
  "reference",
]);

export const GameAssetFile = Schema.Struct({
  role: GameAssetFileRole,
  /** Relative to the project root. */
  path: Schema.String,
  format: Schema.String,
  bytes: NonNegativeInt,
});
export type GameAssetFile = typeof GameAssetFile.Type;

export const GameAssetCheck = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pass", "warn", "fail"]),
  detail: Schema.String,
});
export type GameAssetCheck = typeof GameAssetCheck.Type;

export const GameAssetStats = Schema.Struct({
  triangles: Schema.NullOr(NonNegativeInt),
  materials: Schema.NullOr(NonNegativeInt),
  missingTextures: Schema.NullOr(NonNegativeInt),
  textureMaxSize: Schema.NullOr(NonNegativeInt),
  dimensions: Schema.NullOr(GameAssetDimensions),
});
export type GameAssetStats = typeof GameAssetStats.Type;

export const GameAssetPublication = Schema.Struct({
  service: Schema.Literals(["forgegui", "roblox-open-cloud"]),
  publicationId: Schema.NullOr(Schema.String),
  /** As the service reports it, such as `pending_moderation` or `ready`. */
  status: Schema.String,
  robloxAssetId: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type GameAssetPublication = typeof GameAssetPublication.Type;

export const GameAssetRevision = Schema.Struct({
  revision: Schema.Int,
  createdAt: IsoDateTime,
  createdBy: Schema.Literals(["agent", "user"]),
  tool: Schema.Literals(["blender", "forgegui", "agent", "import"]),
  note: Schema.String,
  files: Schema.Array(GameAssetFile),
  previewPath: Schema.NullOr(Schema.String),
  stats: GameAssetStats,
  checks: Schema.Array(GameAssetCheck),
  brief: Schema.NullOr(GameAssetBrief),
  forgeGui: Schema.NullOr(
    Schema.Struct({
      jobId: Schema.String,
      /** Only what ForgeGUI reported; null means it did not say. */
      creditsCharged: Schema.NullOr(Schema.Number),
      creditsNote: Schema.NullOr(Schema.String),
    }),
  ),
  publication: Schema.NullOr(GameAssetPublication),
});
export type GameAssetRevision = typeof GameAssetRevision.Type;

export const GameAssetImport = Schema.Struct({
  revision: Schema.Int,
  engine: GameEngineId,
  at: IsoDateTime,
  /** Where it landed: an asset path, an instance path, or a Roblox asset id. */
  location: Schema.String,
  status: Schema.Literals(["imported", "failed", "awaiting-approval", "awaiting-moderation"]),
  checks: Schema.Array(GameAssetCheck),
});
export type GameAssetImport = typeof GameAssetImport.Type;

export const GameAsset = Schema.Struct({
  assetId: Schema.String,
  name: Schema.String,
  kind: GameAssetKind,
  projectRoot: Schema.String,
  revisions: Schema.Array(GameAssetRevision),
  imports: Schema.Array(GameAssetImport),
  /** The revision the engine currently uses, if it was imported through Continuum. */
  activeRevision: Schema.NullOr(Schema.Int),
});
export type GameAsset = typeof GameAsset.Type;

export const GameDevAssetsInput = Schema.Struct({ projectRoot: TrimmedNonEmptyString });
export const GameDevAssetPreviewInput = Schema.Struct({
  projectRoot: TrimmedNonEmptyString,
  assetId: TrimmedNonEmptyString,
  revision: Schema.Int,
});
export type GameDevAssetPreviewInput = typeof GameDevAssetPreviewInput.Type;

export const GameDevAssetImportInput = Schema.Struct({
  projectRoot: TrimmedNonEmptyString,
  assetId: TrimmedNonEmptyString,
  revision: Schema.Int,
  /** Replacing an imported revision needs the user to have seen the new preview. */
  confirmReplace: Schema.optionalKey(Schema.Boolean),
});
export type GameDevAssetImportInput = typeof GameDevAssetImportInput.Type;

export const GameDevAssetImportResult = Schema.Struct({
  asset: GameAsset,
  import: GameAssetImport,
  replaceRequired: Schema.NullOr(Schema.String),
});
export type GameDevAssetImportResult = typeof GameDevAssetImportResult.Type;

export const GameDevForgeGuiKeyInput = Schema.Struct({
  /** Null removes the stored key. */
  apiKey: Schema.NullOr(Schema.String),
});
export type GameDevForgeGuiKeyInput = typeof GameDevForgeGuiKeyInput.Type;

export const GameDevForgeGuiTestResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  tools: Schema.Array(Schema.String),
});
export type GameDevForgeGuiTestResult = typeof GameDevForgeGuiTestResult.Type;

export class GameDevError extends Schema.TaggedError<GameDevError>()("GameDevError", {
  message: Schema.String,
}) {}
