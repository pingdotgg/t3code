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
import { AuthAccessTokenResult, AuthSessionState, AuthWebSocketTicketResult } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { type ClientSettings, type QuitConfirmationMode, SnapShotShortcut } from "./settings.ts";
import type { EditorId } from "./editor.ts";
import type { PreviewForwardedShortcut } from "./keybindings.ts";

import type {
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
} from "./desktopAppActivation.ts";

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
}

export interface DesktopUpdateReleaseNote {
  version: string;
  items: ReadonlyArray<string>;
  totalItems: number;
}

export const DesktopUpdateReleaseNoteSchema = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.String),
  totalItems: Schema.Number,
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
  // The web env runtime keys local environments off this so projects routed to
  // a specific backend reopen against the same one.
  id: string;
  label: string;
  // Concrete WSL distro used by the current backend run. This stays separate
  // from id because a default-tracking instance keeps the stable
  // "wsl:default" IPC target while each run launches a specific distro.
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
  targetEnvironmentId?: string;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
});

/**
 * Oversized files carry an empty text so the renderer can reject them by size
 * without the main process ever holding their contents.
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
  enabled: boolean;
  // null means "track the current WSL default distro".
  distro: string | null;
  available: boolean;
  wslOnly: boolean;
  distros: readonly DesktopWslDistro[];
  // Always null in wsl-only mode — that path shows a dialog and falls back to
  // Windows instead.
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
  /**
   * Whether the guest is currently emitting audio. Observed from Chromium, and
   * independent of {@link audioMuted}: a muted tab that is playing still reports
   * `true`, which is what lets the tab strip distinguish "muted and making
   * sound" from "muted and silent".
   */
  audible: boolean;
  controller: "human" | "agent" | "none";
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

export interface DesktopPreviewOpenLinkEvent {
  tabId: string;
  url: string;
  background: boolean;
}

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

export interface DesktopPreviewWebviewConfig {
  partition: string;
  /**
   * Encodes the security posture (sandboxed but contextIsolation off so the
   * picker preload can read the page's React DevTools hook).
   */
  webPreferences: string;
  /**
   * Absolute `file://`-style URL to the picker preload bundle. Set to null
   * when the bundle isn't present (older builds, broken install) — the
   * renderer must then disable element-pick affordances.
   */
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

export interface PickedElementPayload {
  pageUrl: string;
  pageTitle: string | null;
  tagName: string;
  selector: string | null;
  htmlPreview: string;
  componentName: string | null;
  source: PickedElementStackFrame | null;
  stack: ReadonlyArray<PickedElementStackFrame>;
  styles: string;
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
 * Tab creation carries the client's configured browser defaults so the guest is
 * born already zoomed and color-scheme-emulated. Applying them after creation
 * instead would paint one frame at 100%/system first, which reads as a flash on
 * every tab open.
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
   * Derivation stays in main: `will-attach-webview` only prefix-checks the
   * partition string, so a renderer-supplied partition could attach to a
   * session that never had the UA rewrite or permission handlers installed.
   */
  profileId: Schema.optional(BrowserProfileId),
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

export const DesktopPreviewSetAudioMutedInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  audioMuted: Schema.Boolean,
});

export const DesktopPreviewAnnotationThemeInputSchema = Schema.Struct({
  theme: DesktopPreviewAnnotationThemeSchema,
});

export const DesktopPreviewAnnotationSendEnabledInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  enabled: Schema.Boolean,
});

export const DesktopPreviewArtifactInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export const DesktopPreviewRecordingSaveInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  mimeType: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  data: Schema.Uint8Array,
});

export const SystemSettingsPaneSchema = Schema.Literals(["full-disk-access"]);
export type SystemSettingsPane = typeof SystemSettingsPaneSchema.Type;

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getRelayTelemetryEnabled?: () => boolean;
  getPathForFile?: (file: File) => string;
  getClientPlatform?: () => string;
  setNotificationBadge?: (badge: { count: number; image: string | null }) => Promise<void>;
  onNotificationBadgeClear?: (listener: () => void) => () => void;
  onTrackpadScrollEnd?: (listener: () => void) => () => void;
  /**
   * Renderer `window.focus()` cannot raise an Electron window, and on Wayland
   * only the main process can spend a notification click's activation token.
   */
  revealWindow?: () => Promise<void>;
  /**
   * The OS locale as a BCP-47 tag, which the renderer cannot read for itself:
   * the packaged app ships only the `en-US` Chromium locale pak, so
   * `navigator.language` and the default `Intl` locale are pinned to `en-US`
   * regardless of OS settings.
   */
  getSystemLocale?: () => string | null;
  getLocalEnvironmentBootstraps: () => readonly DesktopEnvironmentBootstrap[];
  /** Refresh the preload snapshot without blocking the renderer on synchronous IPC. */
  readLocalEnvironmentBootstraps?: () => Promise<readonly DesktopEnvironmentBootstrap[]>;
  getLocalEnvironmentEnabled?: () => boolean;
  setLocalEnvironmentEnabled?: (enabled: boolean) => Promise<void>;
  getLocalEnvironmentBearerToken: () => Promise<string>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getConnectionCatalog?: () => Promise<string | null>;
  setConnectionCatalog?: (catalog: string) => Promise<boolean>;
  clearConnectionCatalog?: () => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  resolveSshHost: (alias: string) => Promise<DesktopSshEnvironmentTarget>;
  requestSnapShotPermissions?: (includeAccessibility: boolean) => Promise<void>;
  getSnapShotState?: () => Promise<DesktopSnapShotState>;
  setupSnapShot?: (action: DesktopSnapShotSetupAction) => Promise<void>;
  previewSnapShotConfig?: (
    request: DesktopCaptureConfigRequest,
  ) => Promise<DesktopCaptureConfigPreview | null>;
  applySnapShotConfig?: (previewId: string) => Promise<DesktopCaptureConfigApplied>;
  checkSnapShotShortcut?: (
    shortcut: SnapShotShortcut,
  ) => Promise<DesktopSnapShotShortcutAvailability>;
  setSnapShotShortcutSuppressed?: (suppressed: boolean) => Promise<void>;
  listPendingSnapShots?: () => Promise<readonly DesktopPendingSnapShot[]>;
  readSnapShot?: (id: string) => Promise<DesktopSnapShot>;
  setSnapShotAnimationDestination?: (
    destination: DesktopSnapShotAnimationDestination,
  ) => Promise<void>;
  dismissSnapShotAnimation?: (id: DesktopSnapShotId) => Promise<void>;
  acknowledgeSnapShot?: (id: string) => Promise<void>;
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
  issueSshWebSocketTicket: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTicketResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
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
  /** Optional while older desktop shells can host a newer web client. */
  pickProjectFavicon?: (initialPath?: string) => Promise<string | null>;
  pickThemeFiles?: () => Promise<readonly PickedThemeFile[] | null>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  receiveProviderAuthCallback?: (authorizationUrl: string) => Promise<string>;
  cancelProviderAuthCallback?: (authorizationUrl: string) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
  openSystemSettings?: (pane: SystemSettingsPane) => Promise<boolean>;
  checkSystemPermission?: (pane: SystemSettingsPane) => Promise<boolean>;
  /**
   * Optional: older desktop builds lack it; callers fall back to VS Code only.
   */
  probeRemoteEditors?: () => Promise<readonly EditorId[]>;
  pasteAsText?: () => Promise<void>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  onSnapShotEvent?: (listener: (event: DesktopSnapShotEvent) => void) => () => void;
  onQuitShortcut?: (listener: (event: QuitShortcutHintEvent) => void) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => () => void;
  /** App window zoom; older desktop shells omit this method. */
  getWindowZoomFactor?: () => number;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  cliCommand?: {
    getState: () => Promise<DesktopCliCommandState>;
    install: () => Promise<DesktopCliCommandState>;
    uninstall: () => Promise<DesktopCliCommandState>;
  };
  webLinks?: {
    setReady: (ready: boolean) => Promise<void>;
    onOpen: (listener: (url: string) => void) => () => void;
  };
  appActivation?: {
    setReady: (ready: boolean) => Promise<void>;
    complete: (response: DesktopAppActivationResponse) => Promise<void>;
    onRequest: (listener: (request: DesktopAppActivationRequest) => void) => () => void;
  };
  preview?: DesktopPreviewBridge;
}

/** Renderer callback invoked by Electron with a fresh user gesture before display-media capture. */
export const DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER = "__t3DesktopPreviewRecordingCapture";

export interface DesktopPreviewBridge {
  setForwardedShortcuts?: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) => Promise<void>;
  createTab: (tabId: string, defaults?: DesktopPreviewTabDefaults) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  zoomIn: (tabId: string) => Promise<void>;
  zoomOut: (tabId: string) => Promise<void>;
  resetZoom: (tabId: string) => Promise<void>;
  setZoomFactor: (tabId: string, zoomFactor: number) => Promise<void>;
  hardReload: (tabId: string) => Promise<void>;
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>;
  setAudioMuted: (tabId: string, audioMuted: boolean) => Promise<void>;
  openDevTools: (tabId: string) => Promise<void>;
  clearCookies: (environmentId: EnvironmentId, profileId?: string) => Promise<void>;
  clearCache: (environmentId: EnvironmentId, profileId?: string) => Promise<void>;
  getPreviewConfig: (
    environmentId: EnvironmentId,
    profileId?: string,
  ) => Promise<DesktopPreviewWebviewConfig>;
  listBrowserImportSources: () => Promise<ReadonlyArray<BrowserImportSource>>;
  importBrowserCookies: (input: {
    readonly environmentId: EnvironmentId;
    readonly sourceId: BrowserImportSourceId;
    readonly sourceProfileDirectory: string;
    readonly targetProfileId: string;
  }) => Promise<BrowserImportResult>;
  setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>;
  setAnnotationSendEnabled: (tabId: string, enabled: boolean) => Promise<void>;
  /**
   * Activate the in-page element picker for the given tab. Resolves with
   * the picked annotation and its attach/send intent, or `null` when the
   * user cancels (Escape / nav). The promise rejects if the picker can't be
   * activated (no webview, etc.).
   */
  pickElement: (tabId: string) => Promise<PreviewAnnotationSubmissionResult | null>;
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
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
  onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void;
  onOpenLink: (listener: (event: DesktopPreviewOpenLinkEvent) => void) => () => void;
}

export type ConfirmDialogVariant = "default" | "destructive";

export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
}

export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    openSystemSettings: (pane: SystemSettingsPane) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
    close: () => Promise<void>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
  };
}
