import type {
  DesktopTabHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
} from "./previewAutomation.ts";
import type { VaultwardenSetupRequest, VaultwardenSetupResponse } from "./vaultwarden.ts";
import type {
  VaultLoginsRequest,
  VaultLoginsResponse,
  VaultFillRequest,
  VaultFillResult,
} from "./vaultLogins.ts";
import * as Schema from "effect/Schema";
import type { PreviewCaptureFailureEncoded } from "./previewCapture.ts";

import { SnapShotSource } from "./chatAttachment.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import type {
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSourceId,
} from "./browserImport.ts";
import { AuthAccessTokenResult, AuthSessionState } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { type ClientSettings, type QuitConfirmationMode, SnapShotShortcut } from "./settings.ts";
import type { EditorId } from "./editor.ts";
import type { EnvironmentTheme } from "./server.ts";
import { KeybindingShortcut, type PreviewForwardedShortcut } from "./keybindings.ts";

import type {
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
} from "./desktopAppActivation.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  detail?: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders as a non-interactive section header label. Web fallback only — stripped on desktop native menus. */
  header?: boolean;
  /** Icon keyword resolved by the web fallback. Stripped on desktop native menus. */
  icon?: string;
  /** Inserts a visual section divider immediately before this item. */
  separatorBefore?: boolean;
  /** Shows a check mark. Used to mark the current option inside a submenu. */
  checked?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export type QuitShortcutHintEvent =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
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
  detail: Schema.optionalKey(Schema.String),
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

// Native menus opened from the keyboard select their first item, which is what
// moves a screen reader into the menu. Electron assumes a mouse unless told.
export const ContextMenuSource = Schema.Literals(["mouse", "keyboard"]);
export type ContextMenuSource = typeof ContextMenuSource.Type;

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

export const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);
export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Beta", "Dev", "Nightly"]);

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

export const DesktopSnapShotMode = Schema.Literals(["direct", "portal", "unavailable"]);
export type DesktopSnapShotMode = typeof DesktopSnapShotMode.Type;

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

/** Main-process capture lifecycle pushes. `id` is absent for failures before a capture exists. */
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
  /**
   * The version the last install handed to the OS installer that did not
   * apply: the app came back on its old version. Server-triggered updates do
   * not install it again; the user can retry it from the update button.
   */
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

export const DesktopUpdateReleaseNoteSchema = Schema.Struct({
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
  channelBlockedByPolicy: Schema.optionalKey(Schema.Literal(true)),
});

/** The desktop app's `t3` command on PATH, managed from Settings. */
export const DesktopCliCommandStateSchema = Schema.Struct({
  /** Only installed builds have a launcher to put on PATH. */
  supported: Schema.Boolean,
  /** The `t3` the app installed, or null when it is not installed. */
  installedPath: Schema.NullOr(Schema.String),
  /** Whether a new terminal finds it; false when the folder is not on PATH yet. */
  onPath: Schema.Boolean,
  /**
   * Another `t3` a new terminal runs instead, earlier on PATH. Install refuses
   * while it is there, since a link behind it would never run.
   */
  shadowedBy: Schema.optionalKey(Schema.String),
  /** For an installed `t3` that is off PATH: the shell startup file that adds it, and whether it has. */
  pathSetup: Schema.optionalKey(Schema.Struct({ file: Schema.String, added: Schema.Boolean })),
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

// Stable id for the Windows-native primary backend. Desktop side wraps
// this with a brand inside DesktopBackendManager; web side keeps it as
// a plain string so the env-runtime can compare against it without
// importing brand machinery from the desktop package.
export const PRIMARY_LOCAL_ENVIRONMENT_ID = "primary";

export interface DesktopEnvironmentBootstrap {
  // Stable backend instance id (e.g. "primary" or "wsl:ubuntu"). The
  // web env runtime keys local environments off this so projects
  // routed to a specific backend reopen against the same one.
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
export const DesktopSshHostSourceSchema = Schema.Literals(["ssh-config", "known-hosts"]);

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

export const DesktopSshEnvironmentBootstrapSchema = Schema.Struct({
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

export const DesktopSshPasswordPromptCancelledResultSchema = Schema.Struct({
  type: Schema.Literal(DesktopSshPasswordPromptCancelledType),
  message: Schema.String,
});

export const DesktopSshEnvironmentEnsureOptionsSchema = Schema.Struct({
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

export const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
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
  // Opens the dialog against this backend's filesystem (e.g. a WSL project); omit it
  // for the primary's.
  targetEnvironmentId?: string;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
});

/**
 * A file returned by the desktop theme-file picker. Oversized files carry an
 * empty text so the renderer can reject them by size without the main
 * process ever holding their contents.
 */
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

export const DesktopWslDistroSchema = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  version: Schema.Literals([1, 2]),
});

export interface DesktopWslState {
  // True when the user has opted the WSL backend in; the actual backend
  // process is registered with the desktop pool independently of this
  // flag and may take a moment to come up after the user enables it.
  enabled: boolean;
  // null means "track the current WSL default distro".
  distro: string | null;
  available: boolean;
  // When true (and `enabled` is also true) the desktop runs only the
  // WSL backend as the primary; the Windows-side Node backend is not
  // started. Toggling this requires an app restart because the
  // primary backend's spec is captured once at layer init.
  wslOnly: boolean;
  distros: readonly DesktopWslDistro[];
  // Reason the dual-mode WSL backend last failed preflight (no node, wrong
  // version, missing build tools), or null. Surfaced inline in Connections
  // settings. Always null in wsl-only mode — that path shows a dialog and
  // falls back to Windows instead.
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

/**
 * Renderer-facing snapshot of a desktop preview tab. Mirrors the main-process
 * PreviewTabState shape but uses serialisable primitives only.
 */
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

/**
 * Emulated `prefers-color-scheme` for the guest page. "system" clears the
 * override so the page follows the OS appearance.
 */
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
  /** Current zoom factor (1.0 = 100%). */
  zoomFactor: number;
  /** Whether this tab is currently mirrored into a desktop picture-in-picture window. */
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  /**
   * Whether the user has silenced this tab. Per tab rather than per origin, so
   * two tabs on the same site mute independently. Survives navigation and
   * webview swaps, but is dropped when the tab closes.
   */
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

/** A `target="_blank"` link the previewed page asked to open beside itself. */
export interface DesktopPreviewOpenLinkEvent {
  tabId: string;
  url: string;
  /** True for middle-click / Cmd-click, which should not take focus. */
  background: boolean;
}

export interface DesktopPreviewFindResultEvent {
  tabId: string;
  activeMatchOrdinal: number;
  matches: number;
}

/** Recording decorations are forwarded separately from the captured page pixels. */
export const DesktopPreviewRecordingInputSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    phase: Schema.Literals(["move", "down", "up", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite.check(Schema.isGreaterThan(0)),
    height: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
    held: Schema.Boolean,
    width: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ type: Schema.Literal("clear") }),
]);
export type DesktopPreviewRecordingInput = typeof DesktopPreviewRecordingInputSchema.Type;
export interface DesktopPreviewRecordingInputEvent {
  readonly tabId: string;
  readonly input: DesktopPreviewRecordingInput;
}

/**
 * Static config a renderer needs to mount a preview `<webview>`. Returned
 * atomically by `DesktopPreviewBridge.getPreviewConfig()` so the renderer
 * doesn't have to wait on three separate IPC round-trips before the webview
 * can attach.
 */
export interface DesktopPreviewWebviewConfig {
  /** `persist:t3code-preview` (or whatever the desktop chose). */
  partition: string;
  /**
   * Canonical `<webview webpreferences="...">` string. Encodes the security
   * posture (sandboxed but contextIsolation off so the picker preload can
   * read the page's React DevTools hook). Always present.
   */
  webPreferences: string;
  /** Absolute file:// preload URL; null requires disabling element picking. */
  preloadUrl: string | null;
}

export const DesktopPreviewWebviewConfigSchema: Schema.Codec<DesktopPreviewWebviewConfig> =
  Schema.Struct({
    partition: Schema.String,
    webPreferences: Schema.String,
    preloadUrl: Schema.NullOr(Schema.String),
  });

export interface DesktopPreviewAnnotationTheme {
  colorScheme: "light" | "dark";
  radius: string;
  background: string;
  foreground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
  fontSans: string;
  fontMono: string;
}

export const DesktopPreviewAnnotationThemeSchema: Schema.Codec<DesktopPreviewAnnotationTheme> =
  Schema.Struct({
    colorScheme: Schema.Literals(["light", "dark"]),
    radius: Schema.String,
    background: Schema.String,
    foreground: Schema.String,
    popover: Schema.String,
    popoverForeground: Schema.String,
    primary: Schema.String,
    primaryForeground: Schema.String,
    muted: Schema.String,
    mutedForeground: Schema.String,
    accent: Schema.String,
    accentForeground: Schema.String,
    border: Schema.String,
    input: Schema.String,
    ring: Schema.String,
    fontSans: Schema.String,
    fontMono: Schema.String,
  });

export interface DesktopPreviewRecordingFrame {
  tabId: string;
  data: string;
  width: number;
  height: number;
  receivedAt: string;
}

export interface DesktopPreviewRecordingArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewRecordingArtifactSchema: Schema.Codec<DesktopPreviewRecordingArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

export interface DesktopPreviewScreenshotArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: "image/png";
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewScreenshotArtifactSchema: Schema.Codec<DesktopPreviewScreenshotArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.Literal("image/png"),
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

/**
 * Single stack frame captured by react-grab's `getElementContext`. We surface
 * the source file/line so coding agents can jump straight to the JSX that
 * produced the picked DOM node.
 */
export interface PickedElementStackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

export const PickedElementStackFrameSchema: Schema.Codec<PickedElementStackFrame> = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
});

/**
 * A successful element pick from the preview webview. All fields are
 * best-effort — pages that don't ship a React fiber tree (or aren't running
 * in dev) will still produce a usable payload (selector + html preview),
 * just without component / source attribution.
 */
export interface PickedElementPayload {
  /** URL of the page the element was picked on. */
  pageUrl: string;
  /** Optional `<title>` of that page (best-effort). */
  pageTitle: string | null;
  /** Lowercase tag name, e.g. `"button"`. */
  tagName: string;
  /** CSS selector resolving back to the element on a re-render. */
  selector: string | null;
  /** Truncated outer-HTML preview (matches react-grab's `htmlPreview`). */
  htmlPreview: string;
  /** Nearest React component display name, or null when unavailable. */
  componentName: string | null;
  /** First source-mapped stack frame (file + line of the JSX source). */
  source: PickedElementStackFrame | null;
  /** Full owner-stack frames; can be empty. Useful for richer context. */
  stack: ReadonlyArray<PickedElementStackFrame>;
  /** Author CSS only (UA defaults stripped) — react-grab's `styles`. */
  styles: string;
  /** Wall-clock pick time as ISO-8601 string. */
  pickedAt: string;
}

export const PickedElementPayloadSchema: Schema.Codec<PickedElementPayload> = Schema.Struct({
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PickedElementStackFrameSchema),
  stack: Schema.Array(PickedElementStackFrameSchema),
  styles: Schema.String,
  pickedAt: Schema.String,
});

export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PreviewAnnotationRectSchema: Schema.Codec<PreviewAnnotationRect> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

export interface PreviewAnnotationPoint {
  x: number;
  y: number;
}

export const PreviewAnnotationPointSchema: Schema.Codec<PreviewAnnotationPoint> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export interface PreviewAnnotationElementTarget {
  id: string;
  element: PickedElementPayload;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationElementTargetSchema: Schema.Codec<PreviewAnnotationElementTarget> =
  Schema.Struct({
    id: Schema.String,
    element: PickedElementPayloadSchema,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationRegionTarget {
  id: string;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationRegionTargetSchema: Schema.Codec<PreviewAnnotationRegionTarget> =
  Schema.Struct({
    id: Schema.String,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStrokeTarget {
  id: string;
  color: string;
  width: number;
  points: ReadonlyArray<PreviewAnnotationPoint>;
  bounds: PreviewAnnotationRect;
}

export const PreviewAnnotationStrokeTargetSchema: Schema.Codec<PreviewAnnotationStrokeTarget> =
  Schema.Struct({
    id: Schema.String,
    color: Schema.String,
    width: Schema.Number,
    points: Schema.Array(PreviewAnnotationPointSchema),
    bounds: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStyleChange {
  targetId: string;
  selector: string | null;
  property: string;
  previousValue: string;
  value: string;
}

export const PreviewAnnotationStyleChangeSchema: Schema.Codec<PreviewAnnotationStyleChange> =
  Schema.Struct({
    targetId: Schema.String,
    selector: Schema.NullOr(Schema.String),
    property: Schema.String,
    previousValue: Schema.String,
    value: Schema.String,
  });

export interface PreviewAnnotationScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  cropRect: PreviewAnnotationRect;
}

export const PreviewAnnotationScreenshotSchema: Schema.Codec<PreviewAnnotationScreenshot> =
  Schema.Struct({
    dataUrl: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    cropRect: PreviewAnnotationRectSchema,
  });

/**
 * A submitted preview annotation. One annotation may reference multiple DOM
 * elements, freeform regions, and ink strokes. The desktop main process adds
 * the screenshot after the guest preload submits the structured draft.
 */
export interface PreviewAnnotationPayload {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  comment: string;
  elements: ReadonlyArray<PreviewAnnotationElementTarget>;
  regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  styleChanges: ReadonlyArray<PreviewAnnotationStyleChange>;
  screenshot: PreviewAnnotationScreenshot | null;
  createdAt: string;
}

export const PreviewAnnotationPayloadSchema: Schema.Codec<PreviewAnnotationPayload> = Schema.Struct(
  {
    id: Schema.String,
    pageUrl: Schema.String,
    pageTitle: Schema.NullOr(Schema.String),
    comment: Schema.String,
    elements: Schema.Array(PreviewAnnotationElementTargetSchema),
    regions: Schema.Array(PreviewAnnotationRegionTargetSchema),
    strokes: Schema.Array(PreviewAnnotationStrokeTargetSchema),
    styleChanges: Schema.Array(PreviewAnnotationStyleChangeSchema),
    screenshot: Schema.NullOr(PreviewAnnotationScreenshotSchema),
    createdAt: Schema.String,
  },
);

export type PreviewAnnotationSubmission = "attach" | "send";
export const PreviewAnnotationSubmissionSchema: Schema.Codec<PreviewAnnotationSubmission> =
  Schema.Literals(["attach", "send"]);

export interface PreviewAnnotationSubmissionResult {
  annotation: PreviewAnnotationPayload;
  submission: PreviewAnnotationSubmission;
  /** The crop was requested but failed or timed out, so `annotation.screenshot` is null. */
  screenshotFailed?: boolean;
}
export const PreviewAnnotationSubmissionResultSchema: Schema.Codec<PreviewAnnotationSubmissionResult> =
  Schema.Struct({
    annotation: PreviewAnnotationPayloadSchema,
    submission: PreviewAnnotationSubmissionSchema,
    screenshotFailed: Schema.optionalKey(Schema.Boolean),
  });

export const DesktopPreviewTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
});

/**
 * Tab creation carries the browser defaults so the guest starts zoomed and
 * color-scheme-emulated (no 100% flash). Optional so older renderers get the old defaults.
 */
export const DesktopPreviewCreateTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  zoomFactor: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  colorScheme: Schema.optional(DesktopPreviewColorSchemeSchema),
  serverTab: Schema.optional(
    Schema.Struct({ threadId: TrimmedNonEmptyString, tabId: TrimmedNonEmptyString }),
  ),
});

export interface DesktopPreviewTabDefaults {
  readonly zoomFactor?: number | undefined;
  readonly colorScheme?: DesktopPreviewColorScheme | undefined;
  /** A tab of the desktop's own server: the server drives it through the desktop browser channel. */
  readonly serverTab?: { readonly threadId: string; readonly tabId: string } | undefined;
}

export const DesktopPreviewRegisterWebviewInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const DesktopPreviewNavigateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  url: Schema.String,
});

export const DesktopPreviewConfigInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
  /**
   * Browser profile the partition is derived from. Derivation stays in main:
   * `will-attach-webview` only prefix-checks the partition string, so a
   * renderer-supplied partition could attach to a session that never had the
   * UA rewrite or permission handlers installed.
   */
  profileId: Schema.optional(BrowserProfileId),
  /** Carry the partition's loopback traffic to the environment instead of this machine. */
  tunnelLoopback: Schema.optional(Schema.Boolean),
});

export interface DesktopPreviewTunnelAccessRequest {
  readonly requestId: string;
  readonly environmentId: EnvironmentId;
}

export const DesktopPreviewTunnelAccessResolutionInputSchema = Schema.Struct({
  requestId: Schema.String,
  /** The environment's tunnel WebSocket URL with its ticket, or null when it cannot be reached. */
  url: Schema.NullOr(Schema.String),
});

export const DesktopPreviewClearDataInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
  /** Omit to clear every profile; otherwise only this profile's partition. */
  profileId: Schema.optional(BrowserProfileId),
});

export const DesktopPreviewSetColorSchemeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  colorScheme: DesktopPreviewColorSchemeSchema,
});

export const DesktopPreviewSetZoomFactorInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  zoomFactor: Schema.Number.check(Schema.isGreaterThan(0)),
});

export const DesktopPreviewFindInPageInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  text: Schema.NonEmptyString.check(Schema.isMaxLength(1000)),
  forward: Schema.Boolean,
  newSession: Schema.Boolean,
});

export const DesktopPreviewSetAudioMutedInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  audioMuted: Schema.Boolean,
});

export const DesktopPreviewSetCaptureDrawnInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  drawn: Schema.Boolean,
});
export const DesktopPreviewAnnotationThemeInputSchema = Schema.Struct({
  theme: DesktopPreviewAnnotationThemeSchema,
});

export const DesktopPreviewAnnotationSendEnabledInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  enabled: Schema.Boolean,
});

export const DesktopPreviewAnnotationVoiceConfigSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(64)),
  shortcuts: Schema.Array(KeybindingShortcut).check(Schema.isMaxLength(16)),
});

export type DesktopPreviewAnnotationVoiceConfig =
  typeof DesktopPreviewAnnotationVoiceConfigSchema.Type;
export const DesktopPreviewAnnotationVoiceEventSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMaxLength(64)),
  text: Schema.String.check(Schema.isMaxLength(100_000)),
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  selectionEnd: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  action: Schema.Literals([
    "sync",
    "start",
    "stop",
    "cancel",
    "skip",
    "settings",
    "key",
    "focus",
    "blur",
  ]),
  keyboard: Schema.optional(
    Schema.Struct({
      type: Schema.Literals(["keydown", "keyup"]),
      key: Schema.String.check(Schema.isMaxLength(32)),
      code: Schema.String.check(Schema.isMaxLength(64)),
      metaKey: Schema.Boolean,
      ctrlKey: Schema.Boolean,
      shiftKey: Schema.Boolean,
      altKey: Schema.Boolean,
      repeat: Schema.Boolean,
    }),
  ),
});

export type DesktopPreviewAnnotationVoiceEvent =
  typeof DesktopPreviewAnnotationVoiceEventSchema.Type;
export const DesktopPreviewAnnotationVoiceStateSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  sessionId: Schema.String.check(Schema.isMaxLength(64)),
  available: Schema.Boolean,
  phase: Schema.Literals([
    "idle",
    "preparing",
    "recording",
    "transcribing",
    "post-processing",
    "error",
  ]),
  status: Schema.NullOr(Schema.String),
  errorAction: Schema.NullOr(Schema.Literals(["retry", "settings"])),
  preview: Schema.NullOr(Schema.String),
  level: Schema.Number,
  shortcutLabel: Schema.NullOr(Schema.String),
  freezesEditor: Schema.Boolean,
  blocksSubmission: Schema.Boolean,
  draft: Schema.NullOr(Schema.Struct({ text: Schema.String, cursor: Schema.Int })),
});

export type DesktopPreviewAnnotationVoiceState =
  typeof DesktopPreviewAnnotationVoiceStateSchema.Type;
export const DesktopPreviewPickElementInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  voice: Schema.optional(DesktopPreviewAnnotationVoiceConfigSchema),
});

export const DesktopPreviewSetShownInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  shown: Schema.Boolean,
});

const DesktopPreviewDictationUrlSchema = Schema.NullOr(
  Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s"'<>\\]+$/)),
);

export const DesktopPreviewAnnotationDictationInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  /** The http(s) URLs the desktop POSTs to start and stop dictation; null for none. */
  dictation: Schema.Struct({
    startUrl: DesktopPreviewDictationUrlSchema,
    stopUrl: DesktopPreviewDictationUrlSchema,
  }),
});

export const DesktopPreviewArtifactInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export const DesktopPreviewRecordingSaveInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  mimeType: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  data: Schema.Uint8Array,
});

export const DesktopMediaReadSchema = Schema.Struct({
  status: Schema.Number,
  mimeType: Schema.String,
  data: Schema.Uint8Array,
});
export type DesktopMediaRead = typeof DesktopMediaReadSchema.Type;

/**
 * A System Settings pane the app can deep-link to. The identifier crosses IPC
 * rather than a URL, so the renderer can only reach these known destinations.
 */

export const SystemSettingsPaneSchema = Schema.Literals(["full-disk-access"]);
export type SystemSettingsPane = typeof SystemSettingsPaneSchema.Type;

export interface DesktopApiHeader {
  readonly name: string;
  readonly value: string;
}

export interface DesktopApiRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly DesktopApiHeader[];
  readonly body: string | null;
  readonly timeoutMs?: number;
}

export interface DesktopApiResponse {
  /** Set when no response arrived (bad URL, DNS, TLS, timeout); the other fields are empty. */
  readonly error: string | null;
  readonly status: number;
  readonly statusText: string;
  /** The final URL, after redirects. */
  readonly url: string;
  readonly headers: readonly DesktopApiHeader[];
  /** Text for text-like content types, otherwise base64. */
  readonly body: string;
  readonly bodyEncoding: "text" | "base64";
  /** Bytes the server sent; `truncated` when the body kept fewer. */
  readonly size: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** One call to the Orbit Gateway's Conn layer; `path` is below `/api/v1/conn`. */
export interface DesktopOrbitGatewayRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  readonly path: string;
  /** A JSON body, or null. */
  readonly body: string | null;
  /** Query parameters; the main process allows only a few exact ones. */
  readonly query?: Readonly<Record<string, string>>;
  /** Overrides the default 15 s limit, up to 120 s. */
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  /** Conn: `path` is below `/api/v1`; the main process allows only an Instance wake and an Operation read. */
  readonly root?: true;
}

export interface DesktopOrbitGatewayResponse {
  /** Set when no response arrived (DNS, TLS, timeout); `status` is then 0. */
  readonly error: string | null;
  readonly status: number;
  readonly body: string;
}

/** Conn: one call of the Laravel toolbar's Orbit tool, from the desktop main process. */
export interface DesktopOrbitToolRequest {
  /** The thread's environment; writes go only to its own Orbit Instance. */
  readonly environmentId: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** A JSON body, or null. */
  readonly body: string | null;
  readonly timeoutMs?: number;
}

export interface DesktopDatabaseConnection {
  readonly driver: "mysql" | "pgsql" | "sqlite";
  readonly host: string;
  readonly port: number | null;
  /** The database name, or the SQLite file's absolute path. */
  readonly database: string;
  readonly username: string;
  readonly password: string;
  /** nckrtl fork: a Vault Database entry. The desktop app fetches its credentials per call. */
  readonly vaultItemId?: string;
}

export interface DesktopDatabaseRequest {
  readonly connection: DesktopDatabaseConnection;
  /** Whether a locked Vault may ask for Touch ID. Only explicit actions set it. */
  readonly allowUnlock?: boolean;
  /** nckrtl fork: close an open connection first, so a changed Vault entry is read again. */
  readonly reconnect?: boolean;
  readonly operation: "tables" | "describe" | "query";
  readonly table?: string;
  readonly sql?: string;
}

export interface DesktopDatabaseColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly primary: boolean;
}

export interface DesktopDatabaseResponse {
  readonly error: string | null;
  readonly tables: readonly string[];
  readonly columns: readonly DesktopDatabaseColumn[];
  readonly resultColumns: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, string | number | boolean | null>>>;
  /** Rows the query returned; `truncated` when the panel kept the first 500. */
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** nckrtl fork: a Database entry in the Vault Mac app. Listings never carry its password. */
export interface DesktopVaultDatabase {
  readonly id: string;
  readonly name: string;
  readonly driver: "mysql" | "pgsql";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly tls: "disabled" | "required" | "verify-ca" | "verify-full";
  /** Set when the database is reached through SSH; `host` and `port` are then as the server sees them. */
  readonly sshHost: string | null;
  readonly sshPort: number | null;
  readonly sshUser: string | null;
  /** The organization's name, or null for the personal vault. */
  readonly organization: string | null;
}

export interface DesktopVaultDatabasesResponse {
  readonly status: "ok" | "locked" | "unavailable" | "error";
  readonly databases: readonly DesktopVaultDatabase[];
  readonly error: string | null;
}

/** An MCP server the MCP panel connects to: a local command, or a Streamable HTTP / SSE URL. */
export type DesktopMcpServer =
  | {
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      /** Added to the desktop app's environment. */
      readonly env: Readonly<Record<string, string>>;
      /** The folder the command runs in, on this machine; null for the home folder. */
      readonly cwd: string | null;
    }
  | {
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers: readonly DesktopApiHeader[];
    };

export interface DesktopMcpConnectRequest {
  /** Chosen by the panel; a second connect with the same id replaces the first session. */
  readonly sessionId: string;
  readonly server: DesktopMcpServer;
}

export interface DesktopMcpServerInfo {
  readonly name: string;
  readonly title: string | null;
  readonly version: string;
  readonly protocolVersion: string | null;
  readonly instructions: string | null;
  readonly capabilities: {
    readonly tools: boolean;
    readonly resources: boolean;
    readonly prompts: boolean;
    readonly logging: boolean;
  };
}

export interface DesktopMcpConnectResponse {
  readonly error: string | null;
  readonly info: DesktopMcpServerInfo | null;
  readonly durationMs: number;
}

export type DesktopMcpMethod =
  | "ping"
  | "tools/list"
  | "tools/call"
  | "resources/list"
  | "resources/templates/list"
  | "resources/read"
  | "prompts/list"
  | "prompts/get";

export interface DesktopMcpRequest {
  readonly sessionId: string;
  readonly method: DesktopMcpMethod;
  /** The JSON-RPC params. List methods return every page as one result. */
  readonly params: unknown;
}

export interface DesktopMcpResponse {
  readonly error: string | null;
  /** The JSON-RPC result, as the server sent it. */
  readonly result: unknown;
  readonly durationMs: number;
}

/** Traffic of one MCP session, pushed by the main process for the panel's log. */
export interface DesktopMcpEvent {
  readonly sessionId: string;
  readonly at: number;
  /** `send`/`receive`: a JSON-RPC message; `stderr`: server output; `closed`: the session ended. */
  readonly kind: "send" | "receive" | "stderr" | "closed";
  readonly message?: unknown;
  readonly text?: string;
}

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  /** `null` until the desktop host has read the login shell's environment; ask again later. */
  getRelayTelemetryEnabled: () => boolean | null;
  getPathForFile: (file: File) => string;
  getClientPlatform: () => string;
  restartAudioService?: () => Promise<boolean>;
  setNotificationBadge: (badge: { count: number; image: string | null }) => Promise<void>;
  onNotificationBadgeClear: (listener: () => void) => () => void;
  onTrackpadScrollBegin: (listener: () => void) => () => void;
  onTrackpadScrollEnd: (listener: () => void) => () => void;
  /**
   * Renderer `window.focus()` cannot raise an Electron window, and on Wayland
   * only the main process can spend a notification click's activation token.
   */
  revealWindow: () => Promise<void>;
  /**
   * The OS locale as a BCP-47 tag, which the renderer cannot read for itself:
   * the packaged app ships only the `en-US` Chromium locale pak, so
   * `navigator.language` and the default `Intl` locale are pinned to `en-US`
   * regardless of OS settings.
   */
  getSystemLocale: () => string | null;
  /** The OS's preferred languages, most preferred first; `navigator.languages` is pinned like the locale. */
  getPreferredSystemLanguages: () => readonly string[];
  /** False when the OS turned off middle-click PRIMARY paste (`gtk-enable-primary-paste`). */
  getPrimaryPasteEnabled?: () => boolean;
  // One bootstrap per pool instance currently registered with bootstrap
  // info (omits instances whose backend hasn't produced a config yet).
  // The primary backend is identified by id === PRIMARY_LOCAL_ENVIRONMENT_ID.
  getLocalEnvironmentBootstraps: () => readonly DesktopEnvironmentBootstrap[];
  getLocalEnvironmentEnabled: () => boolean;
  setLocalEnvironmentEnabled: (enabled: boolean) => Promise<void>;
  /** The environment ID recorded in this app's T3 home, such as its own machine's background service. */
  getHostEnvironmentId?: () => Promise<string | null>;
  getLocalEnvironmentBearerToken: () => Promise<string>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  /** Themes from this machine's themes folder, read without a local server. */
  getLocalThemes?: () => Promise<readonly EnvironmentTheme[]>;
  onLocalThemesChanged?: (listener: (themes: readonly EnvironmentTheme[]) => void) => () => void;
  getConnectionCatalog: () => Promise<string | null>;
  setConnectionCatalog: (catalog: string) => Promise<boolean>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  /** Resolves a suggested SSH alias before populating the connection form. */
  resolveSshHost: (alias: string) => Promise<DesktopSshEnvironmentTarget>;
  requestSnapShotPermissions: (includeAccessibility: boolean) => Promise<void>;
  getSnapShotState: () => Promise<DesktopSnapShotState>;
  setupSnapShot: (action: DesktopSnapShotSetupAction) => Promise<void>;
  previewSnapShotConfig: (
    request: DesktopCaptureConfigRequest,
  ) => Promise<DesktopCaptureConfigPreview | null>;
  applySnapShotConfig: (previewId: string) => Promise<DesktopCaptureConfigApplied>;
  checkSnapShotShortcut: (
    shortcut: SnapShotShortcut,
  ) => Promise<DesktopSnapShotShortcutAvailability>;
  setSnapShotShortcutSuppressed: (suppressed: boolean) => Promise<void>;
  listPendingSnapShots: () => Promise<readonly DesktopPendingSnapShot[]>;
  readSnapShot: (id: string) => Promise<DesktopSnapShot>;
  setSnapShotAnimationDestination: (
    destination: DesktopSnapShotAnimationDestination,
  ) => Promise<void>;
  dismissSnapShotAnimation: (id: DesktopSnapShotId) => Promise<void>;
  acknowledgeSnapShot: (id: string) => Promise<void>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthAccessTokenResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  /** Fires with a prompt's request id once it is answered, cancelled, expired or abandoned. */
  onSshPasswordPromptSettled: (listener: (requestId: string) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  getWslState: () => Promise<DesktopWslState>;
  setWslBackendEnabled: (enabled: boolean) => Promise<DesktopWslState>;
  setWslDistro: (distro: string | null) => Promise<DesktopWslState>;
  setWslOnly: (enabled: boolean) => Promise<DesktopWslState>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  /** Maps a Windows path to the one a local backend (`primary` or `wsl:…`) sees; null when it cannot. */
  toLocalBackendPath: (backendId: string, windowsPath: string) => Promise<string | null>;
  pickProjectFavicon: (initialPath?: string) => Promise<string | null>;
  pickThemeFiles: () => Promise<readonly PickedThemeFile[] | null>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
    source?: ContextMenuSource,
  ) => Promise<T | null>;
  receiveProviderAuthCallback: (authorizationUrl: string) => Promise<string>;
  cancelProviderAuthCallback: (authorizationUrl: string) => Promise<void>;
  startFileDrag: (input: { environmentId: EnvironmentId; path: string }) => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;
  /** Reads http(s) media in the main process, outside renderer CORS and CSP; null on network failure. */
  readMedia: (url: string) => Promise<DesktopMediaRead | null>;
  /** Open a System Settings pane by identifier. */

  openSystemSettings: (pane: SystemSettingsPane) => Promise<boolean>;
  checkSystemPermission: (pane: SystemSettingsPane) => Promise<boolean>;
  /**
   * Probe this desktop machine for installed remote-capable editor CLIs
   * (used for remote open-in-editor deep links).
   */
  probeRemoteEditors: () => Promise<readonly EditorId[]>;
  /**
   * nckrtl fork: sends one API panel request from the main process (no CORS, all headers,
   * the integrated browser's certificate trust). Optional: other desktop builds lack it.
   */
  apiSend?: (request: DesktopApiRequest) => Promise<DesktopApiResponse>;
  /**
   * nckrtl fork: one Orbit Gateway call for the profile workspace sync, sent by the main process
   * (the Gateway refuses a page Origin). Optional: other desktop builds lack it.
   */
  orbitGatewaySend?: (request: DesktopOrbitGatewayRequest) => Promise<DesktopOrbitGatewayResponse>;
  /**
   * nckrtl fork: one allowlisted call of the Laravel toolbar's Orbit tool, sent by the main process
   * for a thread in an Orbit Instance. Optional: other desktop builds lack it.
   */
  orbitToolSend?: (request: DesktopOrbitToolRequest) => Promise<DesktopOrbitGatewayResponse>;
  /**
   * nckrtl fork: one read-only Database panel call, run by the main process on a direct
   * connection. Optional: other desktop builds lack it.
   */
  databaseRun?: (request: DesktopDatabaseRequest) => Promise<DesktopDatabaseResponse>;
  /** Dedicated Vaultwarden account setup. Secrets are write-only and held by the OS credential store. */
  vaultwardenSetup?: (request: VaultwardenSetupRequest) => Promise<VaultwardenSetupResponse>;
  vaultLogins?: (request: VaultLoginsRequest) => Promise<VaultLoginsResponse>;
  vaultFill?: (request: VaultFillRequest) => Promise<VaultFillResult>;
  /** nckrtl fork: Database entries from the Vault Mac app. `allowUnlock` may prompt for Touch ID. */
  vaultDatabases?: (request: {
    readonly allowUnlock: boolean;
  }) => Promise<DesktopVaultDatabasesResponse>;
  /**
   * nckrtl fork: the MCP panel's sessions, held by the main process (stdio servers run on this
   * machine; HTTP servers get the integrated browser's certificate trust). Optional: other
   * desktop builds lack them.
   */
  mcpConnect?: (request: DesktopMcpConnectRequest) => Promise<DesktopMcpConnectResponse>;
  mcpRequest?: (request: DesktopMcpRequest) => Promise<DesktopMcpResponse>;
  mcpDisconnect?: (sessionId: string) => Promise<void>;
  onMcpEvent?: (listener: (event: DesktopMcpEvent) => void) => () => void;
  /** Performs an ordered plain-text paste. */
  pasteAsText: () => Promise<void>;
  /** Opens an extra desktop window showing a workspace (id or name; null = all projects). */
  openWorkspaceWindow?: (workspace: string | null) => Promise<void>;
  /**
   * Tells the shell which workspace this window is showing, so
   * `t3code://workspace/<name>` can focus it. Optional: older shells lack it.
   */
  reportWorkspace?: (workspace: {
    readonly id: string | null;
    readonly name: string | null;
  }) => Promise<void>;
  /** Which window this is: extra windows carry their starting workspace. Absent in older shells. */
  windowContext?: { readonly additional: boolean; readonly workspace: string | null };
  onMenuAction: (listener: (action: string) => void) => () => void;
  onSnapShotEvent: (listener: (event: DesktopSnapShotEvent) => void) => () => void;
  onQuitShortcut: (listener: (event: QuitShortcutHintEvent) => void) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => () => void;
  getWindowZoomFactor: () => number;
  getUpdateState: () => Promise<DesktopUpdateState>;
  /** `minimumVersion` is a track switch's checked release; nothing older is offered after. */
  setUpdateChannel: (
    channel: DesktopUpdateChannel,
    minimumVersion?: string,
  ) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  /** With a version, installs only that downloaded build. */
  installUpdate: (expectedVersion?: string) => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /** Settings → `t3` command. */
  cliCommand: {
    getState: () => Promise<DesktopCliCommandState>;
    install: () => Promise<DesktopCliCommandState>;
    uninstall: () => Promise<DesktopCliCommandState>;
    addToPath: () => Promise<DesktopCliCommandState>;
  };
  /**
   * Web links the OS opens with Conn as the default browser (macOS). The
   * renderer reports when it listens; links queue in the main process until then.
   */
  webLinks: {
    setReady: (ready: boolean) => Promise<void>;
    onOpen: (listener: (url: string) => void) => () => void;
  };
  appActivation: {
    setReady: (ready: boolean) => Promise<void>;
    complete: (response: DesktopAppActivationResponse) => Promise<void>;
    onRequest: (listener: (request: DesktopAppActivationRequest) => void) => () => void;
  };
  preview: DesktopPreviewBridge;
}

/** Renderer callback invoked by Electron with a fresh user gesture before display-media capture. */
export const DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER = "__t3DesktopPreviewRecordingCapture";

export interface DesktopPreviewBridge {
  getHostDeviceName?: () => Promise<string>;
  connectTabHost?: (input: DesktopTabHost) => Promise<void>;
  executeTabRequest?: (
    runtimeTabId: string,
    connectionId: string,
    request: PreviewAutomationRequest,
  ) => Promise<PreviewAutomationResponse>;
  disconnectTabHost?: (runtimeTabId: string) => Promise<void>;
  setForwardedShortcuts: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) => Promise<void>;
  createTab: (tabId: string, defaults?: DesktopPreviewTabDefaults) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  stopLoading: (tabId: string) => Promise<void>;
  zoomIn: (tabId: string) => Promise<void>;
  zoomOut: (tabId: string) => Promise<void>;
  resetZoom: (tabId: string) => Promise<void>;
  /** Sets a tab's zoom to the factor its environment published, for tabs the server drives. */
  setZoomFactor: (tabId: string, zoomFactor: number) => Promise<void>;
  /** Reload bypassing the HTTP cache. */
  hardReload: (tabId: string) => Promise<void>;
  /**
   * Emulate `prefers-color-scheme` on the guest page ("system" clears the
   * override). Persists per tab and is re-applied across webview swaps.
   */
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>;
  /**
   * Silence the tab's audio output. Persists per tab and is re-applied across
   * webview swaps, but is dropped when the tab closes. Muting a silent tab is
   * allowed; it simply takes effect once the page plays something.
   */
  setAudioMuted: (tabId: string, audioMuted: boolean) => Promise<void>;
  findInPage: (
    tabId: string,
    text: string,
    options: { forward: boolean; newSession: boolean },
  ) => Promise<void>;
  stopFindInPage: (tabId: string) => Promise<void>;
  /** Tells the tab's server whether its webview is on screen. */
  setShown: (tabId: string, shown: boolean) => Promise<void>;
  /** Tells the tab's server whether its webview is drawn at full detail for a capture. */
  setCaptureDrawn: (tabId: string, drawn: boolean) => Promise<void>;
  /** Open the guest webview's DevTools (detached). */
  openDevTools: (tabId: string) => Promise<void>;
  /** Drop cookies + storage data for the preview partition (all tabs). */
  clearCookies: (environmentId: EnvironmentId, profileId?: string) => Promise<void>;
  /** Drop the HTTP cache for the preview partition (all tabs). */
  clearCache: (environmentId: EnvironmentId, profileId?: string) => Promise<void>;
  /**
   * One-shot config for mounting a preview `<webview>`. Replaces three
   * earlier round-trip calls (`getBrowserPartition`, `getWebviewPreferences`,
   * `getPickPreloadPath`) so adding a new field here only requires touching
   * the contract + main, not the renderer's mount logic.
   */
  getPreviewConfig: (
    environmentId: EnvironmentId,
    profileId?: string,
    tunnelLoopback?: boolean,
  ) => Promise<DesktopPreviewWebviewConfig>;
  /** Main asks for an environment's tunnel URL once per connection a tunnelled page opens. */
  onTunnelAccessRequest: (
    listener: (request: DesktopPreviewTunnelAccessRequest) => void,
  ) => () => void;
  resolveTunnelAccess: (requestId: string, url: string | null) => Promise<void>;
  /** Browsers on this machine whose cookies can be imported. */
  listBrowserImportSources: () => Promise<ReadonlyArray<BrowserImportSource>>;
  importBrowserCookies: (input: {
    readonly environmentId: EnvironmentId;
    readonly sourceId: BrowserImportSourceId;
    readonly sourceProfileDirectory: string;
    readonly targetProfileId: string;
  }) => Promise<BrowserImportResult>;
  setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>;
  /** Keep an open annotation picker's send shortcut in sync with its thread grant. */
  setAnnotationSendEnabled: (tabId: string, enabled: boolean) => Promise<void>;
  /** Sets the dictation URLs the desktop POSTs for the tab's overlay (never the page). */
  setAnnotationDictation?: (
    tabId: string,
    dictation: { readonly startUrl: string | null; readonly stopUrl: string | null },
  ) => Promise<void>;
  annotationVoice: {
    onEvent: (
      listener: (tabId: string, event: DesktopPreviewAnnotationVoiceEvent) => void,
    ) => () => void;
    update: (state: DesktopPreviewAnnotationVoiceState) => Promise<void>;
  };
  /** Resolves with the annotation and attach/send intent, or null on cancellation. Rejects if activation fails. */
  pickElement: (
    tabId: string,
    voice?: DesktopPreviewAnnotationVoiceConfig,
  ) => Promise<PreviewAnnotationSubmissionResult | null>;
  /** Cancel an in-flight preview annotation session. */
  cancelPickElement: (tabId: string) => Promise<void>;
  captureScreenshot: (
    tabId: string,
  ) => Promise<DesktopPreviewScreenshotArtifact | PreviewCaptureFailureEncoded>;
  revealArtifact: (path: string) => Promise<void>;
  copyArtifactToClipboard: (path: string) => Promise<void>;
  pictureInPicture: {
    open: (tabId: string) => Promise<void>;
    close: (tabId: string) => Promise<void>;
  };
  recording: {
    onInput: (listener: (event: DesktopPreviewRecordingInputEvent) => void) => () => void;
    startScreencast: (tabId: string) => Promise<void | PreviewCaptureFailureEncoded>;
    stopScreencast: (tabId: string) => Promise<void>;
    save: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Promise<DesktopPreviewRecordingArtifact>;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
  onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void;
  onOpenLink: (listener: (event: DesktopPreviewOpenLinkEvent) => void) => () => void;
  onFindResult: (listener: (event: DesktopPreviewFindResultEvent) => void) => () => void;
}

export type ConfirmDialogVariant = "default" | "destructive";

export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
  /** Which button takes focus on open. Defaults to Cancel; destructive confirms always keep Cancel. */
  readonly initialFocus?: "confirm" | "cancel";
}

/**
 * APIs of the local app shell (dialogs, external links, context menus, app config), not of
 * any backend environment. Never use them as a proxy for the targeted environment.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    /** Opens a known System Settings pane; no-ops outside the desktop app. */
    openSystemSettings: (pane: SystemSettingsPane) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
      source?: ContextMenuSource,
    ) => Promise<T | null>;
    close: () => Promise<void>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
  };
}
