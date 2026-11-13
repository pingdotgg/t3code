import * as Schema from "effect/Schema";
import { SnapShotSource } from "./chatAttachment.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { type QuitConfirmationMode, SnapShotShortcut } from "./settings.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  header?: boolean;
  icon?: string;
  separatorBefore?: boolean;
  checked?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export type QuitShortcutHintEvent =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly header?: boolean;
  readonly icon?: string;
  readonly separatorBefore?: boolean;
  readonly checked?: boolean;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  header: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(Schema.String),
  separatorBefore: Schema.optionalKey(Schema.Boolean),
  checked: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ContextMenuItemSchemaType> => ContextMenuItemSchema),
    ),
  ),
});

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";

export type DesktopTheme = "light" | "dark" | "system";

export type DesktopUpdateChannel = "latest" | "nightly";

export type DesktopAppStageLabel = "Alpha" | "Beta" | "Dev" | "Nightly";

const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);

const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);

export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);

export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);

const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Beta", "Dev", "Nightly"]);

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export const DesktopAppBrandingSchema = Schema.Struct({
  baseName: Schema.String,
  stageLabel: DesktopAppStageLabelSchema,
  displayName: Schema.String,
});

const DesktopSnapShotMode = Schema.Literals(["direct", "portal", "unavailable"]);
type DesktopSnapShotMode = typeof DesktopSnapShotMode.Type;

export const DesktopCaptureExtensionState = Schema.Struct({
  status: Schema.Literals([
    "not-installed",
    "disabled",
    "enabled",
    "restart-required",
    "update-required",
    "extensions-disabled",
    "unsupported",
    "error",
  ]),
  message: Schema.String,
});
export type DesktopCaptureExtensionState = typeof DesktopCaptureExtensionState.Type;

export const DesktopCaptureHelperState = Schema.Struct({
  status: Schema.Literals(["not-installed", "update-required", "ready", "error"]),
  message: Schema.String,
  feedbackAvailable: Schema.optional(Schema.Boolean),
});
export type DesktopCaptureHelperState = typeof DesktopCaptureHelperState.Type;

export const DesktopSnapShotSetupAction = Schema.Literals([
  "install-extension",
  "enable-extension",
  "disable-extension",
  "install-kde-helper",
  "remove-kde-helper",
  "install-hyprland-helper",
  "remove-hyprland-helper",
  "test-mac-capture",
  "allow-screen-recording",
  "allow-accessibility",
  "retry-shortcut",
]);
export type DesktopSnapShotSetupAction = typeof DesktopSnapShotSetupAction.Type;

export const DesktopCaptureConfigRequest = Schema.Struct({
  operation: Schema.Literals(["install", "remove"]),
  chooseFile: Schema.Boolean,
  shortcut: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
});
export type DesktopCaptureConfigRequest = typeof DesktopCaptureConfigRequest.Type;

export const DesktopCaptureConfigPreview = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  resolvedPath: Schema.String,
  before: Schema.String,
  after: Schema.String,
  shortcut: Schema.String,
  operation: Schema.Literals(["install", "remove"]),
});
export type DesktopCaptureConfigPreview = typeof DesktopCaptureConfigPreview.Type;

export const DesktopCaptureConfigApplied = Schema.Struct({
  backupPath: Schema.NullOr(Schema.String),
  warning: Schema.NullOr(Schema.String),
});
export type DesktopCaptureConfigApplied = typeof DesktopCaptureConfigApplied.Type;

export const DesktopSnapShotState = Schema.Struct({
  mode: DesktopSnapShotMode,
  windows: Schema.optional(Schema.Boolean),
  linuxDesktop: Schema.optional(Schema.Literals(["gnome", "kde", "niri", "hyprland"])),
  linuxBackend: Schema.optional(
    Schema.Literals(["screenshot-portal", "gnome-extension", "niri", "kde", "hyprland", "picker"]),
  ),
  linuxFeedbackAvailable: Schema.optional(Schema.Boolean),
  shortcut: SnapShotShortcut,
  shortcutRegistered: Schema.Boolean,
  shortcutPending: Schema.optional(Schema.Boolean),
  shortcutCanRetry: Schema.optional(Schema.Boolean),
  shortcutLabel: Schema.optional(Schema.String),
  shortcutMessage: Schema.NullOr(Schema.String),
  shortcutBinding: Schema.optional(Schema.String),
  shortcutConfigPath: Schema.optional(Schema.String),
  shortcutActionRegistered: Schema.optional(Schema.Boolean),
  gnomeExtension: Schema.optional(DesktopCaptureExtensionState),
  kdeHelper: Schema.optional(DesktopCaptureHelperState),
  hyprlandHelper: Schema.optional(DesktopCaptureHelperState),
  macPermissions: Schema.optional(
    Schema.Struct({ screenRecording: Schema.Boolean, accessibility: Schema.Boolean }),
  ),
  shortcutVerified: Schema.optional(Schema.Boolean),
  message: Schema.NullOr(Schema.String),
});
export type DesktopSnapShotState = typeof DesktopSnapShotState.Type;

export const DesktopSnapShotShortcutAvailability = Schema.Struct({
  available: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type DesktopSnapShotShortcutAvailability = typeof DesktopSnapShotShortcutAvailability.Type;

export const DesktopSnapShotId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9-]+$/i),
);
export type DesktopSnapShotId = typeof DesktopSnapShotId.Type;

/** `id` is absent for failures before a capture exists. */
export const DesktopSnapShotEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("requested"), id: DesktopSnapShotId }),
  Schema.Struct({ type: Schema.Literal("started"), id: DesktopSnapShotId }),
  Schema.Struct({ type: Schema.Literal("ready"), id: DesktopSnapShotId }),
  Schema.Struct({ type: Schema.Literal("failed"), id: Schema.optional(DesktopSnapShotId) }),
  Schema.Struct({ type: Schema.Literal("shortcut-changed") }),
]);
export type DesktopSnapShotEvent = typeof DesktopSnapShotEvent.Type;

export const DesktopPendingSnapShot = Schema.Struct({
  id: DesktopSnapShotId,
  name: Schema.String,
  mimeType: Schema.Literal("image/png"),
  sizeBytes: Schema.Int,
  source: SnapShotSource,
});
export type DesktopPendingSnapShot = typeof DesktopPendingSnapShot.Type;

export const DesktopSnapShot = Schema.Struct({
  ...DesktopPendingSnapShot.fields,
  dataUrl: Schema.String,
});
export type DesktopSnapShot = typeof DesktopSnapShot.Type;

export const DesktopSnapShotAnimationDestination = Schema.Struct({
  id: DesktopSnapShotId,
  viewportFrame: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  backgroundColor: Schema.String,
  borderColor: Schema.String,
  borderWidth: Schema.Number,
  cornerRadius: Schema.Number,
  details: Schema.optional(
    Schema.Struct({
      appName: SnapShotSource.fields.appName,
      windowTitle: SnapShotSource.fields.windowTitle,
      appIconDataUrl: SnapShotSource.fields.appIconDataUrl,
    }),
  ),
});
export type DesktopSnapShotAnimationDestination = typeof DesktopSnapShotAnimationDestination.Type;

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  omittedReleaseCount: number;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  notAppliedVersion?: string;
  /** Off only because a managed policy rules out this channel; switching channels turns it on. */
  channelBlockedByPolicy?: true;
}

export interface DesktopUpdateReleaseNote {
  version: string;
  items: ReadonlyArray<string>;
  totalItems: number;
  /** ISO time from the update feed for the offered version, else `YYYY-MM-DD` from a prerelease version. */
  releasedAt?: string;
  /** Paragraph-style summaries from older releases keep their fixes in `items`. */
  intro?: string;
  /** Generated summaries only, for example "275 changes from 22 contributors". */
  stats?: string;
  footer?: string;
}

const DesktopUpdateReleaseNoteSchema = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.String),
  totalItems: Schema.Number,
  releasedAt: Schema.optionalKey(Schema.String),
  intro: Schema.optionalKey(Schema.String),
  stats: Schema.optionalKey(Schema.String),
  footer: Schema.optionalKey(Schema.String),
});

export const DesktopUpdateStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatusSchema,
  channel: DesktopUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  releaseNotes: Schema.Array(DesktopUpdateReleaseNoteSchema),
  omittedReleaseCount: Schema.Number,
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
  notAppliedVersion: Schema.optionalKey(Schema.String),
});

export const DesktopCliCommandStateSchema = Schema.Struct({
  supported: Schema.Boolean,
  installedPath: Schema.NullOr(Schema.String),
  onPath: Schema.Boolean,
  shadowedBy: Schema.optionalKey(Schema.String),
  /** The app's bundled `t3` launcher, which runs without Node or a PATH entry. */
  launcherPath: Schema.NullOr(Schema.String),
});

export type DesktopCliCommandState = typeof DesktopCliCommandStateSchema.Type;

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateActionResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateCheckResultSchema = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export const PRIMARY_LOCAL_ENVIRONMENT_ID = "primary";

export interface DesktopEnvironmentBootstrap {
  // Stable backend identity used to reopen routed projects.
  id: string;
  label: string;
  // Actual distro for this run; id stays wsl:default when tracking the default.
  runningDistro?: string | null;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export const DesktopEnvironmentBootstrapSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  runningDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  httpBaseUrl: Schema.NullOr(Schema.String),
  wsBaseUrl: Schema.NullOr(Schema.String),
  bootstrapToken: Schema.optionalKey(Schema.String),
});

export const DesktopSshEnvironmentTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});

export type DesktopSshEnvironmentTarget = typeof DesktopSshEnvironmentTargetSchema.Type;

export type DesktopSshHostSource = "ssh-config" | "known-hosts";

const DesktopSshHostSourceSchema = Schema.Literals(["ssh-config", "known-hosts"]);

export interface DesktopDiscoveredSshHost extends DesktopSshEnvironmentTarget {
  source: DesktopSshHostSource;
}

export const DesktopDiscoveredSshHostSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  source: DesktopSshHostSourceSchema,
});

export interface DesktopSshEnvironmentBootstrap {
  target: DesktopSshEnvironmentTarget;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pairingToken: string | null;
  remotePort?: number;
  remoteServerKind?: "external" | "managed";
}

const DesktopSshEnvironmentBootstrapSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  pairingToken: Schema.NullOr(Schema.String),
  remotePort: Schema.optionalKey(Schema.Number),
  remoteServerKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
});

export interface DesktopSshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: string;
}

export const DesktopSshPasswordPromptCancelledType = "ssh-password-prompt-cancelled" as const;

const DesktopSshPasswordPromptCancelledResultSchema = Schema.Struct({
  type: Schema.Literal(DesktopSshPasswordPromptCancelledType),
  message: Schema.String,
});

const DesktopSshEnvironmentEnsureOptionsSchema = Schema.Struct({
  issuePairingToken: Schema.optionalKey(Schema.Boolean),
});

export const DesktopSshEnvironmentEnsureInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  options: Schema.optionalKey(DesktopSshEnvironmentEnsureOptionsSchema),
});

export const DesktopSshEnvironmentEnsureResultSchema = Schema.Union([
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPasswordPromptCancelledResultSchema,
]);

export const DesktopSshHttpBaseUrlInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
});

export const DesktopSshBearerRequestInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  bearerToken: Schema.String,
});

export const DesktopSshBearerBootstrapInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
});

export const DesktopSshPasswordPromptResolutionInputSchema = Schema.Struct({
  requestId: Schema.String,
  password: Schema.NullOr(Schema.String),
});

const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshEnvironmentTargetSchema),
  relayManaged: Schema.optionalKey(
    Schema.Struct({
      relayUrl: Schema.String,
    }),
  ),
});

export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecordSchema.Type;

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export const DesktopServerExposureModeSchema = Schema.Literals([
  "local-only",
  "network-accessible",
]);

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
}

export const DesktopServerExposureStateSchema = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  endpointUrl: Schema.NullOr(Schema.String),
  advertisedHost: Schema.NullOr(Schema.String),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Number,
});

export interface PickFolderOptions {
  initialPath?: string | null;
  targetEnvironmentId?: string;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
});

/** Oversized files have empty text so the main process never loads their contents. */
export interface PickedThemeFile {
  name: string;
  size: number;
  text: string;
}

export const PickedThemeFileSchema = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  text: Schema.String,
});

export interface DesktopWslDistro {
  name: string;
  isDefault: boolean;
  version: 1 | 2;
}

const DesktopWslDistroSchema = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  version: Schema.Literals([1, 2]),
});

export interface DesktopWslState {
  enabled: boolean;
  // null means "track the current WSL default distro".
  distro: string | null;
  available: boolean;
  wslOnly: boolean;
  distros: readonly DesktopWslDistro[];
  // Always null in wsl-only mode, which falls back to Windows with a dialog.
  preflightError: string | null;
}

export const DesktopWslStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  distro: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  wslOnly: Schema.Boolean,
  distros: Schema.Array(DesktopWslDistroSchema),
  preflightError: Schema.NullOr(Schema.String),
});

export type DesktopPreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export type DesktopPreviewColorScheme = "system" | "light" | "dark";

export const DesktopPreviewColorSchemeSchema: Schema.Codec<DesktopPreviewColorScheme> =
  Schema.Literals(["system", "light", "dark"]);

export const FAVICON_DATA_URL_MAX_LENGTH = 8192;

export const FAVICON_CAPTURED_AT_MAX = 8_640_000_000_000_000;

export interface DesktopPreviewFavicon {
  dataUrl: string;
  pageUrl: string;
  capturedAt: number;
}

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  audioMuted: boolean;
  /** Chromium reports playback even when audioMuted is true. */
  audible: boolean;
  controller: "human" | "agent" | "none";
  /** A screenshot or stream of the guest is pending, so the client keeps it painting while hidden. */
  capturing: boolean;
  favicon?: DesktopPreviewFavicon;
  updatedAt: string;
}

export const DesktopPreviewTabIdSchema = Schema.String.check(Schema.isTrimmed()).check(
  Schema.isNonEmpty(),
);

export interface DesktopPreviewPointerEvent {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  sequence: number;
  createdAt: string;
}
