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
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type {
  PreviewCloseInput,
  PreviewDiscoverLocalServersInput,
  PreviewDiscoverLocalServersResult,
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
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  ServerConfig,
  ServerExportThreadMarkdownInput,
  ServerExportThreadMarkdownResult,
  ServerListSkillsResult,
  ServerProviderListCommandsInput,
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
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetTurnDiffStateInput,
  OrchestrationGetTurnDiffStateResult,
  OrchestrationShellStreamItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import { EnvironmentId, IsoDateTime, ThreadId, TurnId } from "./baseSchemas.ts";
import { EditorId } from "./editor.ts";
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
  | { kind: "idle" }
  | { kind: "loading"; url: string; title: string | null }
  | { kind: "success"; url: string; title: string | null }
  | {
      kind: "failed";
      url: string;
      title: string | null;
      errorCode: number;
      errorText: string;
    };

export interface DesktopPreviewTabState {
  tabId: string;
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  zoomFactor: number;
  navStatus: DesktopPreviewNavStatus;
  updatedAt: string;
}

export interface DesktopPreviewCreateTabInput {
  tabId: string;
  url: string;
  partition?: string;
}

export interface DesktopPreviewRegisterWebviewInput {
  tabId: string;
  webContentsId: number;
  partition?: string;
}

export interface DesktopPreviewNavigateInput {
  tabId: string;
  url: string;
}

export interface DesktopPreviewTabInput {
  tabId: string;
}

export interface DesktopPreviewScreenshotResult {
  tabId: string;
  dataUrl: string;
  capturedAt: string;
}

export interface DesktopPreviewRecordingFrame {
  dataUrl: string;
  capturedAt: string;
}

export interface DesktopPreviewRecordingResult {
  tabId: string;
  startedAt: string;
  stoppedAt: string;
  frames: readonly DesktopPreviewRecordingFrame[];
}

export interface DesktopPreviewAnnotationInput extends DesktopPreviewTabInput {
  selector: string;
  label?: string;
}

export type DesktopPreviewAutomationCommand =
  | { type: "click"; tabId: string; selector: string }
  | { type: "type"; tabId: string; selector: string; text: string }
  | { type: "key"; tabId: string; key: string };

export interface DesktopPreviewAutomationResult {
  ok: boolean;
  value?: unknown;
}

export type DesktopPreviewStateChange =
  | { type: "updated"; state: DesktopPreviewTabState }
  | { type: "closed"; tabId: string };

export interface DesktopPreviewBridge {
  createTab: (input: DesktopPreviewCreateTabInput) => Promise<DesktopPreviewTabState>;
  registerWebview: (input: DesktopPreviewRegisterWebviewInput) => Promise<DesktopPreviewTabState>;
  navigate: (input: DesktopPreviewNavigateInput) => Promise<DesktopPreviewTabState>;
  goBack: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  goForward: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  refresh: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  hardReload: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  zoomIn: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  zoomOut: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  resetZoom: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewTabState | null>;
  openDevTools: (input: DesktopPreviewTabInput) => Promise<void>;
  clearCookies: (input: DesktopPreviewTabInput) => Promise<void>;
  clearCache: (input: DesktopPreviewTabInput) => Promise<void>;
  captureScreenshot: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewScreenshotResult>;
  startRecording: (input: DesktopPreviewTabInput) => Promise<void>;
  stopRecording: (input: DesktopPreviewTabInput) => Promise<DesktopPreviewRecordingResult>;
  annotateElement: (input: DesktopPreviewAnnotationInput) => Promise<void>;
  clearAnnotations: (input: DesktopPreviewTabInput) => Promise<void>;
  runAutomation: (
    input: DesktopPreviewAutomationCommand,
  ) => Promise<DesktopPreviewAutomationResult>;
  closeTab: (input: DesktopPreviewTabInput) => Promise<void>;
  onStateChange: (listener: (change: DesktopPreviewStateChange) => void) => () => void;
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
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  preview: {
    open: (input: PreviewOpenInput) => Promise<PreviewSessionSnapshot>;
    navigate: (input: PreviewNavigateInput) => Promise<PreviewSessionSnapshot>;
    reportStatus: (input: PreviewReportStatusInput) => Promise<void>;
    resize: (input: PreviewResizeInput) => Promise<PreviewSessionSnapshot>;
    refresh: (input: PreviewRefreshInput) => Promise<void>;
    close: (input: PreviewCloseInput) => Promise<void>;
    list: (input: PreviewListInput) => Promise<PreviewListResult>;
    discoverLocalServers: (
      input: PreviewDiscoverLocalServersInput,
    ) => Promise<PreviewDiscoverLocalServersResult>;
    onEvent: (callback: (event: PreviewEvent) => void) => () => void;
  };
  git: {
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<GitCreateBranchResult>;
    checkout: (input: GitCheckoutInput) => Promise<GitCheckoutResult>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
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
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getTurnDiffState: (
      input: OrchestrationGetTurnDiffStateInput,
    ) => Promise<OrchestrationGetTurnDiffStateResult>;
    getFullThreadDiffState: (
      input: OrchestrationGetFullThreadDiffStateInput,
    ) => Promise<OrchestrationGetFullThreadDiffStateResult>;
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
