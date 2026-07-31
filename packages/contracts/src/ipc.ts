import type {
  GitCheckoutInput,
  GitCheckoutResult,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListOpenPullRequestsInput,
  GitListOpenPullRequestsResult,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolveReviewChangesContextInput,
  GitResolveReviewChangesContextResult,
  GitResolvePullRequestResult,
  GitStatusInput,
  GitStatusResult,
  GitCreateBranchResult,
} from "./git.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type { AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
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
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  PreviewAutomationPressInput,
  type PreviewAutomationResponse,
  PreviewAutomationScrollInput,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationStreamEvent,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "./previewAutomation.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  ServerConfig,
  ServerExportThreadMarkdownInput,
  ServerExportThreadMarkdownResult,
  ServerListSkillsResult,
  ServerProviderListCommandsInput,
  ServerProviderPrewarmSessionInput,
  ServerProviderListCommandsResult,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import type { ServerUpsertKeybindingInput } from "./server.ts";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetFullThreadDiffStateInput,
  OrchestrationGetFullThreadDiffStateResult,
  OrchestrationGetThreadActivitiesInput,
  OrchestrationGetThreadActivitiesResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetTurnDiffStateInput,
  OrchestrationGetTurnDiffStateResult,
  OrchestrationSearchTranscriptInput,
  OrchestrationSearchTranscriptResult,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import { EnvironmentId, IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";
import { EditorId } from "./editor.ts";
import type { WorkflowRunResult } from "./agentWorkflows.ts";
import type { WorkflowRunInput } from "./workflowRuntime.ts";
import { ServerSettings, type ClientSettings, type ServerSettingsPatch } from "./settings.ts";
import { Schema } from "effect";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

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

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

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
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export interface PersistedSavedEnvironmentRecord {
  environmentId: EnvironmentId;
  label: string;
  wsBaseUrl: string;
  httpBaseUrl: string;
  createdAt: string;
  lastConnectedAt: string | null;
}

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
}

export const DesktopThreadCompletionNotificationStatus = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type DesktopThreadCompletionNotificationStatus =
  typeof DesktopThreadCompletionNotificationStatus.Type;

export const DesktopNotificationRequest = Schema.Struct({
  kind: Schema.Literal("thread-turn-completed"),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnId: TurnId,
  title: Schema.String,
  body: Schema.String,
  status: DesktopThreadCompletionNotificationStatus,
  createdAt: IsoDateTime,
});
export type DesktopNotificationRequest = typeof DesktopNotificationRequest.Type;

export interface DesktopNotificationClick {
  kind: "thread-turn-completed";
  environmentId: EnvironmentId;
  threadId: ThreadId;
  turnId: TurnId;
}

export interface PickFolderOptions {
  initialPath?: string | null;
}

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

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Current zoom factor (1.0 = 100%). */
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  controller: "human" | "agent" | "none";
  updatedAt: string;
}

export const DesktopPreviewTabIdSchema = Schema.String.check(Schema.isTrimmed()).check(
  Schema.isNonEmpty(),
);

export const DesktopPreviewNavStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Idle") }),
  Schema.Struct({
    kind: Schema.Literal("Loading"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("Success"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("LoadFailed"),
    url: Schema.String,
    title: Schema.String,
    code: Schema.Number,
    description: Schema.String,
  }),
]);

export const DesktopPreviewTabStateSchema: Schema.Codec<DesktopPreviewTabState> = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.NullOr(Schema.Int),
  navStatus: DesktopPreviewNavStatusSchema,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoomFactor: Schema.Number,
  colorScheme: DesktopPreviewColorSchemeSchema,
  controller: Schema.Literals(["human", "agent", "none"]),
  updatedAt: Schema.String,
});

export interface DesktopPreviewPointerEvent {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  sequence: number;
  createdAt: string;
}

export const DesktopPreviewPointerEventSchema: Schema.Codec<DesktopPreviewPointerEvent> =
  Schema.Struct({
    tabId: DesktopPreviewTabIdSchema,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Number,
    y: Schema.Number,
    sequence: Schema.Int,
    createdAt: Schema.String,
  });

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

export const DesktopPreviewRecordingFrameSchema: Schema.Codec<DesktopPreviewRecordingFrame> =
  Schema.Struct({
    tabId: DesktopPreviewTabIdSchema,
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    receivedAt: Schema.String,
  });

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

export const DesktopPreviewTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
});

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
});

export const DesktopPreviewSetColorSchemeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  colorScheme: DesktopPreviewColorSchemeSchema,
});

export const DesktopPreviewAnnotationThemeInputSchema = Schema.Struct({
  theme: DesktopPreviewAnnotationThemeSchema,
});

export const DesktopPreviewArtifactInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export const DesktopPreviewRecordingSaveInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  mimeType: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  data: Schema.Uint8Array,
});

export const DesktopPreviewAutomationClickInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationClickInput,
});

export const DesktopPreviewAutomationTypeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationTypeInput,
});

export const DesktopPreviewAutomationPressInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationPressInput,
});

export const DesktopPreviewAutomationScrollInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationScrollInput,
});

export const DesktopPreviewAutomationEvaluateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationEvaluateInput,
});

export const DesktopPreviewAutomationWaitForInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  input: PreviewAutomationWaitForInput,
});

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
  /**
   * Emulate `prefers-color-scheme` on the guest page ("system" clears the
   * override). Persists per tab and is re-applied across webview swaps.
   */
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>;
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
  setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>;
  /**
   * Activate the in-page element picker for the given tab. Resolves with
   * the picked payload, or `null` when the user cancels (Escape / nav). The
   * promise rejects if the picker can't be activated (no webview, etc.).
   */
  pickElement: (tabId: string) => Promise<PreviewAnnotationPayload | null>;
  /** Cancel an in-flight preview annotation session. */
  cancelPickElement: (tabId: string) => Promise<void>;
  captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>;
  revealArtifact: (path: string) => Promise<void>;
  copyArtifactToClipboard: (path: string) => Promise<void>;
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
  onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void;
}

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  preview?: DesktopPreviewBridge;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  setVibrancy: (enabled: boolean, options?: { readonly persist?: boolean }) => Promise<boolean>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  showNotification: (request: DesktopNotificationRequest) => Promise<boolean>;
  onNotificationClick: (listener: (click: DesktopNotificationClick) => void) => () => void;
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
    revealInFileManager: (path: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  notifications: {
    show: (request: DesktopNotificationRequest) => Promise<boolean>;
    onClick: (listener: (click: DesktopNotificationClick) => void) => () => void;
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
    listProviderCommands: (
      input: ServerProviderListCommandsInput,
    ) => Promise<ServerProviderListCommandsResult>;
    prewarmProviderSession: (input: ServerProviderPrewarmSessionInput) => Promise<unknown>;
    listSkills: () => Promise<ServerListSkillsResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    exportThreadMarkdown: (
      input: ServerExportThreadMarkdownInput,
    ) => Promise<ServerExportThreadMarkdownResult>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, and git operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  assets: {
    createUrl: (input: AssetCreateUrlInput) => Promise<AssetCreateUrlResult>;
  };
  preview: {
    open: (input: PreviewOpenInput) => Promise<PreviewSessionSnapshot>;
    navigate: (input: PreviewNavigateInput) => Promise<PreviewSessionSnapshot>;
    resize: (input: PreviewResizeInput) => Promise<PreviewSessionSnapshot>;
    refresh: (input: PreviewRefreshInput) => Promise<void>;
    close: (input: PreviewCloseInput) => Promise<void>;
    list: (input: PreviewListInput) => Promise<PreviewListResult>;
    reportStatus: (input: PreviewReportStatusInput) => Promise<void>;
    automation: {
      connect: (
        input: PreviewAutomationHost,
        callback: (event: PreviewAutomationStreamEvent) => void,
        options?: { onResubscribe?: () => void },
      ) => () => void;
      respond: (response: PreviewAutomationResponse) => Promise<void>;
      focusHost: (input: PreviewAutomationHostFocus) => Promise<void>;
    };
    onEvent: (
      callback: (event: PreviewEvent) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
    subscribePorts: (
      callback: (servers: DiscoveredLocalServerList) => void,
      options?: { onResubscribe?: () => void },
    ) => () => void;
  };
  git: {
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<GitCreateBranchResult>;
    checkout: (input: GitCheckoutInput) => Promise<GitCheckoutResult>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    listOpenPullRequests: (
      input: GitListOpenPullRequestsInput,
    ) => Promise<GitListOpenPullRequestsResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    resolveReviewChangesContext: (
      input: GitResolveReviewChangesContextInput,
    ) => Promise<GitResolveReviewChangesContextResult>;
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    refreshStatus: (input: GitStatusInput) => Promise<GitStatusResult>;
    onStatus: (
      input: GitStatusInput,
      callback: (status: GitStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  server: {
    exportThreadMarkdown: (
      input: ServerExportThreadMarkdownInput,
    ) => Promise<ServerExportThreadMarkdownResult>;
    listProviderCommands: (
      input: ServerProviderListCommandsInput,
    ) => Promise<ServerProviderListCommandsResult>;
    prewarmProviderSession: (input: ServerProviderPrewarmSessionInput) => Promise<unknown>;
  };
  workflow: {
    run: (input: WorkflowRunInput) => Promise<WorkflowRunResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getThreadActivities: (
      input: OrchestrationGetThreadActivitiesInput,
    ) => Promise<OrchestrationGetThreadActivitiesResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getTurnDiffState: (
      input: OrchestrationGetTurnDiffStateInput,
    ) => Promise<OrchestrationGetTurnDiffStateResult>;
    getFullThreadDiffState: (
      input: OrchestrationGetFullThreadDiffStateInput,
    ) => Promise<OrchestrationGetFullThreadDiffStateResult>;
    searchTranscript: (
      input: OrchestrationSearchTranscriptInput,
    ) => Promise<OrchestrationSearchTranscriptResult>;
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
}
