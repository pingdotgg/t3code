import type {
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  VcsStatusInput,
  VcsStatusResult,
} from "./git.ts";
import type { ReviewDiffPreviewInput, ReviewDiffPreviewResult } from "./review.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  ServerConfig,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerProviderUpdateInput,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import type {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import type { ServerRemoveKeybindingInput, ServerUpsertKeybindingInput } from "./server.ts";
import * as Schema from "effect/Schema";
import type {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import type {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationOwner,
  PreviewAutomationPressInput,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "./previewAutomation.ts";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { AuthAccessTokenResult, AuthSessionState, AuthWebSocketTicketResult } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { EditorId } from "./editor.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import type { ClientSettings, ServerSettings, ServerSettingsPatch } from "./settings.ts";
import type {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders as a non-interactive section header label. Web fallback only — stripped on desktop native menus. */
  header?: boolean;
  /** Icon keyword resolved by the web fallback. Stripped on desktop native menus. */
  icon?: string;
  children?: readonly ContextMenuItem<T>[];
}

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly header?: boolean;
  readonly icon?: string;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  header: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(Schema.String),
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
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

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
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);

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

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export const DesktopRuntimeInfoSchema = Schema.Struct({
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
});

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
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

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
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
});

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

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export const DesktopEnvironmentBootstrapSchema = Schema.Struct({
  label: Schema.String,
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

export const DesktopSshPasswordPromptRequestSchema = Schema.Struct({
  requestId: Schema.String,
  destination: Schema.String,
  username: Schema.NullOr(Schema.String),
  prompt: Schema.String,
  expiresAt: Schema.String,
});

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
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const DesktopCloudAuthFetchInputSchema = Schema.Struct({
  url: Schema.String,
  method: Schema.optionalKey(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optionalKey(Schema.String),
});
export type DesktopCloudAuthFetchInput = typeof DesktopCloudAuthFetchInputSchema.Type;

export const DesktopCloudAuthFetchResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.Number,
  statusText: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
export type DesktopCloudAuthFetchResult = typeof DesktopCloudAuthFetchResultSchema.Type;

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

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Current zoom factor (1.0 = 100%). */
  zoomFactor: number;
  controller: "human" | "agent" | "none";
  updatedAt: string;
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
  /**
   * Absolute `file://`-style URL to the picker preload bundle. Set to null
   * when the bundle isn't present (older builds, broken install) — the
   * renderer must then disable element-pick affordances.
   */
  preloadUrl: string | null;
}

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

export interface DesktopPreviewScreenshotArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: "image/png";
  sizeBytes: number;
  createdAt: string;
}

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

export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewAnnotationPoint {
  x: number;
  y: number;
}

export interface PreviewAnnotationElementTarget {
  id: string;
  element: PickedElementPayload;
  rect: PreviewAnnotationRect;
}

export interface PreviewAnnotationRegionTarget {
  id: string;
  rect: PreviewAnnotationRect;
}

export interface PreviewAnnotationStrokeTarget {
  id: string;
  color: string;
  width: number;
  points: ReadonlyArray<PreviewAnnotationPoint>;
  bounds: PreviewAnnotationRect;
}

export interface PreviewAnnotationStyleChange {
  targetId: string;
  selector: string | null;
  property: string;
  previousValue: string;
  value: string;
}

export interface PreviewAnnotationScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  cropRect: PreviewAnnotationRect;
}

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

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
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
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  createCloudAuthRequest: () => Promise<string>;
  getCloudAuthToken: () => Promise<string | null>;
  setCloudAuthToken: (token: string) => Promise<boolean>;
  clearCloudAuthToken: () => Promise<void>;
  fetchCloudAuth: (input: DesktopCloudAuthFetchInput) => Promise<DesktopCloudAuthFetchResult>;
  onCloudAuthCallback: (listener: (rawUrl: string) => void) => () => void;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /**
   * Desktop-only preview surface. Present iff the renderer is hosted by the
   * Electron desktop build; web builds have `preview === undefined`.
   */
  preview?: DesktopPreviewBridge;
}

export interface DesktopPreviewBridge {
  createTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  zoomIn: (tabId: string) => Promise<void>;
  zoomOut: (tabId: string) => Promise<void>;
  resetZoom: (tabId: string) => Promise<void>;
  /** Reload bypassing the HTTP cache. */
  hardReload: (tabId: string) => Promise<void>;
  /** Open the guest webview's DevTools (detached). */
  openDevTools: (tabId: string) => Promise<void>;
  /** Drop cookies + storage data for the preview partition (all tabs). */
  clearCookies: () => Promise<void>;
  /** Drop the HTTP cache for the preview partition (all tabs). */
  clearCache: () => Promise<void>;
  /**
   * One-shot config for mounting a preview `<webview>`. Replaces three
   * earlier round-trip calls (`getBrowserPartition`, `getWebviewPreferences`,
   * `getPickPreloadPath`) so adding a new field here only requires touching
   * the contract + main, not the renderer's mount logic.
   */
  getPreviewConfig: (environmentId: EnvironmentId) => Promise<DesktopPreviewWebviewConfig>;
  /**
   * Activate the in-page element picker for the given tab. Resolves with
   * the picked payload, or `null` when the user cancels (Escape / nav). The
   * promise rejects if the picker can't be activated (no webview, etc.).
   */
  pickElement: (tabId: string) => Promise<PreviewAnnotationPayload | null>;
  /** Cancel an in-flight preview annotation session. */
  cancelPickElement: (tabId: string) => Promise<void>;
  captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>;
  recording: {
    startScreencast: (tabId: string) => Promise<void>;
    stopScreencast: (tabId: string) => Promise<void>;
    save: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Promise<DesktopPreviewRecordingArtifact>;
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  automation: {
    status: (tabId: string) => Promise<PreviewAutomationStatus>;
    snapshot: (tabId: string) => Promise<PreviewAutomationSnapshot>;
    click: (tabId: string, input: PreviewAutomationClickInput) => Promise<void>;
    type: (tabId: string, input: PreviewAutomationTypeInput) => Promise<void>;
    press: (tabId: string, input: PreviewAutomationPressInput) => Promise<void>;
    scroll: (tabId: string, input: PreviewAutomationScrollInput) => Promise<void>;
    evaluate: (tabId: string, input: PreviewAutomationEvaluateInput) => Promise<unknown>;
    waitFor: (tabId: string, input: PreviewAutomationWaitForInput) => Promise<void>;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, editor/external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
    getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
    setSavedEnvironmentRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Promise<void>;
    getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
    setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
    removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    /**
     * Refresh provider snapshots. When `input.instanceId` is supplied only that
     * configured instance is probed; otherwise every configured instance is
     * refreshed (legacy untargeted refresh).
     */
    refreshProviders: (input?: {
      readonly instanceId?: ProviderInstanceId;
    }) => Promise<ServerProviderUpdatedPayload>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdatedPayload>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    removeKeybinding: (input: ServerRemoveKeybindingInput) => Promise<ServerRemoveKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>;
    getTraceDiagnostics: () => Promise<ServerTraceDiagnosticsResult>;
    getProcessDiagnostics: () => Promise<ServerProcessDiagnosticsResult>;
    getProcessResourceHistory: (
      input: ServerProcessResourceHistoryInput,
    ) => Promise<ServerProcessResourceHistoryResult>;
    signalProcess: (input: ServerSignalProcessInput) => Promise<ServerSignalProcessResult>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, VCS, and provider operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    attach: (
      input: typeof TerminalAttachInput.Encoded,
      callback: (event: TerminalAttachStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onMetadata: (
      callback: (event: TerminalMetadataStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  sourceControl: {
    lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Promise<SourceControlRepositoryInfo>;
    cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Promise<SourceControlCloneRepositoryResult>;
    publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Promise<SourceControlPublishRepositoryResult>;
  };
  vcs: {
    listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
    createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
    removeWorktree: (input: VcsRemoveWorktreeInput) => Promise<void>;
    createRef: (input: VcsCreateRefInput) => Promise<VcsCreateRefResult>;
    switchRef: (input: VcsSwitchRefInput) => Promise<VcsSwitchRefResult>;
    init: (input: VcsInitInput) => Promise<void>;
    pull: (input: VcsPullInput) => Promise<VcsPullResult>;
    refreshStatus: (input: VcsStatusInput) => Promise<VcsStatusResult>;
    onStatus: (
      input: VcsStatusInput,
      callback: (status: VcsStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  git: {
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
  };
  review: {
    getDiffPreview: (input: ReviewDiffPreviewInput) => Promise<ReviewDiffPreviewResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getArchivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    subscribeShell: (
      callback: (event: OrchestrationShellStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  preview: {
    open: (input: typeof PreviewOpenInput.Encoded) => Promise<PreviewSessionSnapshot>;
    navigate: (input: typeof PreviewNavigateInput.Encoded) => Promise<PreviewSessionSnapshot>;
    refresh: (input: typeof PreviewRefreshInput.Encoded) => Promise<void>;
    close: (input: typeof PreviewCloseInput.Encoded) => Promise<void>;
    list: (input: typeof PreviewListInput.Encoded) => Promise<PreviewListResult>;
    reportStatus: (input: typeof PreviewReportStatusInput.Encoded) => Promise<void>;
    automation: {
      connect: (
        input: { clientId: string },
        callback: (request: PreviewAutomationRequest) => void,
        options?: { onResubscribe?: () => void },
      ) => () => void;
      respond: (response: PreviewAutomationResponse) => Promise<void>;
      reportOwner: (owner: PreviewAutomationOwner) => Promise<void>;
      clearOwner: (input: { clientId: string }) => Promise<void>;
    };
    onEvent: (callback: (event: PreviewEvent) => void) => () => void;
    subscribePorts: (
      callback: (servers: DiscoveredLocalServerList) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
  };
}
