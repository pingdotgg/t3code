import * as Schema from "effect/Schema";
import type { PreviewCaptureFailureEncoded } from "./previewCapture.ts";
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
import { type ClientSettings, SnapShotShortcut } from "./settings.ts";
import type { EditorId } from "./editor.ts";
import type { PreviewForwardedShortcut } from "./keybindings.ts";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "./desktopAppActivation.ts";
import type { ContextMenuItem, DesktopAppBranding, DesktopCliCommandState, DesktopDiscoveredSshHost, DesktopEnvironmentBootstrap, DesktopPreviewColorScheme, DesktopPreviewPointerEvent, DesktopPreviewTabState, DesktopServerExposureMode, DesktopServerExposureState, DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentTarget, DesktopSshPasswordPromptRequest, DesktopTheme, DesktopUpdateActionResult, DesktopUpdateChannel, DesktopUpdateCheckResult, DesktopUpdateState, DesktopWslState, PickFolderOptions, PickedThemeFile, QuitShortcutHintEvent } from "./ipcPart2.ts";
import { DesktopCaptureConfigApplied, DesktopCaptureConfigPreview, DesktopCaptureConfigRequest, DesktopPendingSnapShot, DesktopPreviewColorSchemeSchema, DesktopPreviewTabIdSchema, DesktopSnapShot, DesktopSnapShotAnimationDestination, DesktopSnapShotEvent, DesktopSnapShotId, DesktopSnapShotSetupAction, DesktopSnapShotShortcutAvailability, DesktopSnapShotState } from "./ipcPart2.ts";
export type {
  ContextMenuItem,
  ContextMenuItemSchemaType,
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopCliCommandState,
  DesktopDiscoveredSshHost,
  DesktopEnvironmentBootstrap,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewNavStatus,
  DesktopPreviewPointerEvent,
  DesktopPreviewTabState,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
  DesktopServerExposureMode,
  DesktopServerExposureState,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshHostSource,
  DesktopSshPasswordPromptRequest,
  DesktopTheme,
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateReleaseNote,
  DesktopUpdateState,
  DesktopUpdateStatus,
  DesktopWslDistro,
  DesktopWslState,
  PersistedSavedEnvironmentRecord,
  PickFolderOptions,
  PickedThemeFile,
  QuitShortcutHintEvent,
} from "./ipcPart2.ts";
export {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopCaptureConfigApplied,
  DesktopCaptureConfigPreview,
  DesktopCaptureConfigRequest,
  DesktopCaptureExtensionState,
  DesktopCaptureHelperState,
  DesktopCliCommandStateSchema,
  DesktopDiscoveredSshHostSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopPendingSnapShot,
  DesktopServerExposureModeSchema,
  DesktopServerExposureStateSchema,
  DesktopSnapShot,
  DesktopSnapShotAnimationDestination,
  DesktopSnapShotEvent,
  DesktopSnapShotId,
  DesktopSnapShotSetupAction,
  DesktopSnapShotShortcutAvailability,
  DesktopSnapShotState,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshEnvironmentTargetSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshPasswordPromptCancelledType,
  DesktopSshPasswordPromptResolutionInputSchema,
  DesktopThemeSchema,
  DesktopUpdateActionResultSchema,
  DesktopUpdateChannelSchema,
  DesktopUpdateCheckResultSchema,
  DesktopUpdateStateSchema,
  DesktopWslStateSchema,
  FAVICON_CAPTURED_AT_MAX,
  FAVICON_DATA_URL_MAX_LENGTH,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  PickFolderOptionsSchema,
  PickedThemeFileSchema,
} from "./ipcPart2.ts";

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
  /** Sandboxed with contextIsolation off so the picker preload can read the React DevTools hook. */
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

const DesktopPreviewAnnotationThemeSchema: Schema.Codec<DesktopPreviewAnnotationTheme> =
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

const PickedElementStackFrameSchema: Schema.Codec<PickedElementStackFrame> = Schema.Struct({
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

const PickedElementPayloadSchema: Schema.Codec<PickedElementPayload> = Schema.Struct({
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

const PreviewAnnotationRectSchema: Schema.Codec<PreviewAnnotationRect> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

export interface PreviewAnnotationPoint {
  x: number;
  y: number;
}

const PreviewAnnotationPointSchema: Schema.Codec<PreviewAnnotationPoint> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export interface PreviewAnnotationElementTarget {
  id: string;
  element: PickedElementPayload;
  rect: PreviewAnnotationRect;
}

const PreviewAnnotationElementTargetSchema: Schema.Codec<PreviewAnnotationElementTarget> =
  Schema.Struct({
    id: Schema.String,
    element: PickedElementPayloadSchema,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationRegionTarget {
  id: string;
  rect: PreviewAnnotationRect;
}

const PreviewAnnotationRegionTargetSchema: Schema.Codec<PreviewAnnotationRegionTarget> =
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

const PreviewAnnotationStrokeTargetSchema: Schema.Codec<PreviewAnnotationStrokeTarget> =
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

const PreviewAnnotationStyleChangeSchema: Schema.Codec<PreviewAnnotationStyleChange> =
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

const PreviewAnnotationScreenshotSchema: Schema.Codec<PreviewAnnotationScreenshot> =
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

const PreviewAnnotationSubmissionSchema: Schema.Codec<PreviewAnnotationSubmission> =
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

/** Apply zoom and color scheme at creation to avoid flashing browser defaults. */
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
  /** Main must derive the partition to ensure its session has UA rewrites and permission handlers. */
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

export const DesktopMediaReadSchema = Schema.Struct({
  status: Schema.Number,
  mimeType: Schema.String,
  data: Schema.Uint8Array,
});

export type DesktopMediaRead = typeof DesktopMediaReadSchema.Type;

export const SystemSettingsPaneSchema = Schema.Literals(["full-disk-access"]);

export type SystemSettingsPane = typeof SystemSettingsPaneSchema.Type;

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getRelayTelemetryEnabled: () => boolean;
  getPathForFile: (file: File) => string;
  getClientPlatform: () => string;
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
  getLocalEnvironmentBootstraps: () => readonly DesktopEnvironmentBootstrap[];
  getLocalEnvironmentEnabled: () => boolean;
  setLocalEnvironmentEnabled: (enabled: boolean) => Promise<void>;
  getLocalEnvironmentBearerToken: () => Promise<string>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getConnectionCatalog: () => Promise<string | null>;
  setConnectionCatalog: (catalog: string) => Promise<boolean>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
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
  pickProjectFavicon: (initialPath?: string) => Promise<string | null>;
  pickThemeFiles: () => Promise<readonly PickedThemeFile[] | null>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  receiveProviderAuthCallback: (authorizationUrl: string) => Promise<string>;
  cancelProviderAuthCallback: (authorizationUrl: string) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
  /** Reads http(s) media in the main process, outside renderer CORS and CSP; null on network failure. */
  readMedia: (url: string) => Promise<DesktopMediaRead | null>;
  openSystemSettings: (pane: SystemSettingsPane) => Promise<boolean>;
  checkSystemPermission: (pane: SystemSettingsPane) => Promise<boolean>;
  probeRemoteEditors: () => Promise<readonly EditorId[]>;
  pasteAsText: () => Promise<void>;
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
  cliCommand: {
    getState: () => Promise<DesktopCliCommandState>;
    install: () => Promise<DesktopCliCommandState>;
    uninstall: () => Promise<DesktopCliCommandState>;
  };
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
  setForwardedShortcuts: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) => Promise<void>;
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
  /** Resolves with the annotation and attach/send intent, or null on cancellation. Rejects if activation fails. */
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
