import type {
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsCreateRefInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  VcsStatusInput,
  VcsStatusResult,
  VcsCreateRefResult,
} from "./git.ts";
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
  ServerProviderUpdateInput,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
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
import type { ServerRemoveKeybindingInput, ServerUpsertKeybindingInput } from "./server.ts";
import * as Schema from "effect/Schema";
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
import { AuthBearerBootstrapResult, AuthSessionState, AuthWebSocketTokenResult } from "./auth.ts";
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
  children?: readonly ContextMenuItem<T>[];
}

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
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
  ) => Promise<AuthBearerBootstrapResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketToken: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTokenResult>;
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
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
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
}
