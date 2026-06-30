import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  WorkSourceConnectionView,
  WorkSourceProviderName,
  ListImportableWorkItemsResult,
  ImportWorkItemsResult,
} from "./workSource.ts";
import { OutboundConnectionView, CreateOutboundConnectionInput } from "./outbound.ts";

import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { MessageId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import { AssetAccessError, AssetCreateUrlInput, AssetCreateUrlResult } from "./assets.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalHistoryAttachInput,
  TerminalHistoryAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewCloseInput,
  PreviewError,
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
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
  AgentSelection,
  BoardId,
  BoardListEntry,
  BoardSnapshot,
  BoardStreamItem,
  LaneKey,
  StepRunId,
  TicketDiff,
  TicketId,
  WorkflowBoardVersionSummary,
  WorkflowGetBoardDefinitionResult,
  WorkflowGetBoardVersionResult,
  WorkflowImportBoardInput,
  WorkflowImportBoardResult,
  WorkflowCreateWorkflowBoardInput,
  WorkflowCreateWorkflowBoardResult,
  WorkflowGenerateWorkflowDraftInput,
  WorkflowGenerateWorkflowDraftResult,
  WorkflowListBoardTemplatesResult,
  WorkflowNeedsAttentionTicketView,
  WorkflowBoardName,
  WorkflowRenameBoardInput,
  WorkflowSaveBoardDefinitionInput,
  WorkflowSaveBoardDefinitionResult,
  WorkflowRpcError,
  TicketAttachment,
  WorkflowIntakeBraindump,
  WorkflowIntakeResult,
  WorkflowTicketArtifactsResult,
  WorkflowWebhookConfig,
  WorkflowBoardDigest,
  WorkflowBoardMetrics,
  WorkflowDefinitionEncoded,
  WorkflowDryRunResult,
  WorkflowDryRunScenario,
  WorkflowTicketDetailView,
  WorkflowProposeBoardImprovementInput,
  WorkflowProposeBoardImprovementResult,
  WorkflowListBoardProposalsInput,
  WorkflowListBoardProposalsResult,
  WorkflowGetBoardProposalInput,
  WorkflowGetBoardProposalResult,
  WorkflowResolveBoardProposalInput,
  WorkflowResolveBoardProposalResult,
  WorkflowRevertBoardProposalInput,
  WorkflowRevertBoardProposalResult,
  WORKFLOW_WS_METHODS,
} from "./workflow.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalAttachHistory: "terminal.attachHistory",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewReportStatus: "preview.reportStatus",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: EnvironmentAuthorizationError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
    error: EnvironmentAuthorizationError,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
  },
);

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

/**
 * Ephemeral live diff preview for compact/mobile surfaces.
 * Not the persisted T3 Review model. Future review sessions should use
 * review.open* + review.getSnapshot.
 */
export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalAttachHistoryRpc = Rpc.make(WS_METHODS.terminalAttachHistory, {
  payload: TerminalHistoryAttachInput,
  success: TerminalHistoryAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: Schema.Union([OrchestrationReplayEventsError, EnvironmentAuthorizationError]),
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationGetSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

export const WsWorkflowListBoardsRpc = Rpc.make(WORKFLOW_WS_METHODS.listBoards, {
  payload: Schema.Struct({ projectId: ProjectId }),
  success: Schema.Array(BoardListEntry),
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowCreateBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.createBoard, {
  payload: Schema.Struct({
    projectId: ProjectId,
    // Align with WorkflowCreateBoardInput/renameBoard: enforce the branded name
    // bounds at the wire boundary instead of accepting any string.
    name: WorkflowBoardName,
    agent: AgentSelection,
  }),
  success: Schema.Struct({ boardId: BoardId, snapshot: BoardSnapshot }),
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowDeleteBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.deleteBoard, {
  payload: Schema.Struct({ boardId: BoardId }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowRenameBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.renameBoard, {
  payload: WorkflowRenameBoardInput,
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.getBoard, {
  payload: Schema.Struct({ boardId: BoardId }),
  success: BoardSnapshot,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetBoardDefinitionRpc = Rpc.make(WORKFLOW_WS_METHODS.getBoardDefinition, {
  payload: Schema.Struct({ boardId: BoardId }),
  success: WorkflowGetBoardDefinitionResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowSaveBoardDefinitionRpc = Rpc.make(WORKFLOW_WS_METHODS.saveBoardDefinition, {
  payload: WorkflowSaveBoardDefinitionInput,
  success: WorkflowSaveBoardDefinitionResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowImportBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.importBoard, {
  payload: WorkflowImportBoardInput,
  success: WorkflowImportBoardResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowCreateWorkflowBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.createWorkflowBoard, {
  payload: WorkflowCreateWorkflowBoardInput,
  success: WorkflowCreateWorkflowBoardResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGenerateWorkflowDraftRpc = Rpc.make(
  WORKFLOW_WS_METHODS.generateWorkflowDraft,
  {
    payload: WorkflowGenerateWorkflowDraftInput,
    success: WorkflowGenerateWorkflowDraftResult,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowListBoardTemplatesRpc = Rpc.make(WORKFLOW_WS_METHODS.listBoardTemplates, {
  payload: Schema.Struct({}),
  success: WorkflowListBoardTemplatesResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowListBoardVersionsRpc = Rpc.make(WORKFLOW_WS_METHODS.listBoardVersions, {
  payload: Schema.Struct({ boardId: BoardId }),
  success: Schema.Array(WorkflowBoardVersionSummary),
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetBoardVersionRpc = Rpc.make(WORKFLOW_WS_METHODS.getBoardVersion, {
  payload: Schema.Struct({ boardId: BoardId, versionId: Schema.Int }),
  success: WorkflowGetBoardVersionResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowSubscribeBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.subscribeBoard, {
  payload: Schema.Struct({ boardId: BoardId }),
  success: BoardStreamItem,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  stream: true,
});

// Bound ticket title/description at decode so an unbounded value can never
// bloat SQLite or the agent instruction templates the engine persists them
// into. Caps mirror WorkflowTicketDetail (title ≤200) and the other 4000-char
// description caps in workflow.ts; title is non-empty to match the engine's
// TicketCreated event schema.
const WorkflowTicketTitleInput = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const WorkflowTicketDescriptionInput = Schema.String.check(Schema.isMaxLength(4000));

export const WsWorkflowCreateTicketRpc = Rpc.make(WORKFLOW_WS_METHODS.createTicket, {
  payload: Schema.Struct({
    boardId: BoardId,
    title: WorkflowTicketTitleInput,
    description: Schema.optional(WorkflowTicketDescriptionInput),
    initialLane: LaneKey,
    dependsOn: Schema.optional(Schema.Array(TicketId)),
    tokenBudget: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({ ticketId: TicketId }),
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowEditTicketRpc = Rpc.make(WORKFLOW_WS_METHODS.editTicket, {
  payload: Schema.Struct({
    ticketId: TicketId,
    // Same caps as create (title ≤200 non-empty, description ≤4000) so an edit
    // can't reintroduce an unbounded value the create path now rejects.
    title: Schema.optional(WorkflowTicketTitleInput),
    description: Schema.optional(WorkflowTicketDescriptionInput),
    dependsOn: Schema.optional(Schema.Array(TicketId)),
    tokenBudget: Schema.optional(Schema.NullOr(Schema.Int)),
  }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowMoveTicketRpc = Rpc.make(WORKFLOW_WS_METHODS.moveTicket, {
  payload: Schema.Struct({ ticketId: TicketId, toLane: LaneKey }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowRunLaneRpc = Rpc.make(WORKFLOW_WS_METHODS.runLane, {
  payload: Schema.Struct({ ticketId: TicketId }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowResolveApprovalRpc = Rpc.make(WORKFLOW_WS_METHODS.resolveApproval, {
  payload: Schema.Struct({ stepRunId: StepRunId, approved: Schema.Boolean }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowAnswerTicketStepRpc = Rpc.make(WORKFLOW_WS_METHODS.answerTicketStep, {
  payload: Schema.Struct({
    stepRunId: StepRunId,
    text: Schema.optional(Schema.String),
    attachments: Schema.optional(Schema.Array(TicketAttachment)),
  }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowPostTicketMessageRpc = Rpc.make(WORKFLOW_WS_METHODS.postTicketMessage, {
  payload: Schema.Struct({
    ticketId: TicketId,
    text: Schema.optional(Schema.String),
    attachments: Schema.optional(Schema.Array(TicketAttachment)),
  }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowEditTicketMessageRpc = Rpc.make(WORKFLOW_WS_METHODS.editTicketMessage, {
  payload: Schema.Struct({
    ticketId: TicketId,
    messageId: MessageId,
    body: Schema.String,
  }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowSetProjectScriptTrustRpc = Rpc.make(
  WORKFLOW_WS_METHODS.setProjectScriptTrust,
  {
    payload: Schema.Struct({ projectId: ProjectId, trusted: Schema.Boolean }),
    success: Schema.Void,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowCancelStepRpc = Rpc.make(WORKFLOW_WS_METHODS.cancelStep, {
  payload: Schema.Struct({ stepRunId: StepRunId }),
  success: Schema.Void,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetTicketDetailRpc = Rpc.make(WORKFLOW_WS_METHODS.getTicketDetail, {
  payload: Schema.Struct({ ticketId: TicketId }),
  success: WorkflowTicketDetailView,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowIntakeTicketsRpc = Rpc.make(WORKFLOW_WS_METHODS.intakeTickets, {
  payload: Schema.Struct({
    boardId: BoardId,
    braindump: WorkflowIntakeBraindump,
    agent: AgentSelection,
  }),
  success: WorkflowIntakeResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowListTicketArtifactsRpc = Rpc.make(WORKFLOW_WS_METHODS.listTicketArtifacts, {
  payload: Schema.Struct({ ticketId: TicketId }),
  success: WorkflowTicketArtifactsResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetWebhookConfigRpc = Rpc.make(WORKFLOW_WS_METHODS.getWebhookConfig, {
  payload: Schema.Struct({ boardId: BoardId, rotate: Schema.optional(Schema.Boolean) }),
  success: WorkflowWebhookConfig,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetBoardDigestRpc = Rpc.make(WORKFLOW_WS_METHODS.getBoardDigest, {
  payload: Schema.Struct({ boardId: BoardId, windowHours: Schema.optional(Schema.Int) }),
  success: WorkflowBoardDigest,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetBoardMetricsRpc = Rpc.make(WORKFLOW_WS_METHODS.getBoardMetrics, {
  payload: Schema.Struct({ boardId: BoardId, windowDays: Schema.optional(Schema.Int) }),
  success: WorkflowBoardMetrics,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowDryRunBoardRpc = Rpc.make(WORKFLOW_WS_METHODS.dryRunBoard, {
  payload: Schema.Struct({
    definition: WorkflowDefinitionEncoded,
    startLane: LaneKey,
    scenario: WorkflowDryRunScenario,
  }),
  success: WorkflowDryRunResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetTicketDiffRpc = Rpc.make(WORKFLOW_WS_METHODS.getTicketDiff, {
  payload: Schema.Struct({ ticketId: TicketId }),
  success: TicketDiff,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowListNeedsAttentionTicketsRpc = Rpc.make(
  WORKFLOW_WS_METHODS.listNeedsAttentionTickets,
  {
    payload: Schema.Struct({}),
    success: Schema.Array(WorkflowNeedsAttentionTicketView),
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowListWorkSourceConnectionsRpc = Rpc.make(
  WORKFLOW_WS_METHODS.listWorkSourceConnections,
  {
    payload: Schema.Struct({}),
    success: Schema.Array(WorkSourceConnectionView),
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowCreateWorkSourceConnectionRpc = Rpc.make(
  WORKFLOW_WS_METHODS.createWorkSourceConnection,
  {
    payload: Schema.Struct({
      provider: WorkSourceProviderName,
      displayName: TrimmedNonEmptyString,
      token: TrimmedNonEmptyString,
      authMode: Schema.optional(Schema.Literals(["pat", "basic", "bearer"])),
      baseUrl: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
    success: WorkSourceConnectionView,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowDeleteWorkSourceConnectionRpc = Rpc.make(
  WORKFLOW_WS_METHODS.deleteWorkSourceConnection,
  {
    payload: Schema.Struct({ connectionRef: TrimmedNonEmptyString }),
    success: Schema.Void,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowListOutboundConnectionsRpc = Rpc.make(
  WORKFLOW_WS_METHODS.listOutboundConnections,
  {
    payload: Schema.Struct({}),
    success: Schema.Struct({ connections: Schema.Array(OutboundConnectionView) }),
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowCreateOutboundConnectionRpc = Rpc.make(
  WORKFLOW_WS_METHODS.createOutboundConnection,
  {
    payload: CreateOutboundConnectionInput,
    success: Schema.Struct({ connection: OutboundConnectionView }),
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowDeleteOutboundConnectionRpc = Rpc.make(
  WORKFLOW_WS_METHODS.deleteOutboundConnection,
  {
    payload: Schema.Struct({ connectionRef: TrimmedNonEmptyString }),
    success: Schema.Void,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowProposeBoardImprovementRpc = Rpc.make(
  WORKFLOW_WS_METHODS.proposeBoardImprovement,
  {
    payload: WorkflowProposeBoardImprovementInput,
    success: WorkflowProposeBoardImprovementResult,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowListBoardProposalsRpc = Rpc.make(WORKFLOW_WS_METHODS.listBoardProposals, {
  payload: WorkflowListBoardProposalsInput,
  success: WorkflowListBoardProposalsResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowGetBoardProposalRpc = Rpc.make(WORKFLOW_WS_METHODS.getBoardProposal, {
  payload: WorkflowGetBoardProposalInput,
  success: WorkflowGetBoardProposalResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowResolveBoardProposalRpc = Rpc.make(
  WORKFLOW_WS_METHODS.resolveBoardProposal,
  {
    payload: WorkflowResolveBoardProposalInput,
    success: WorkflowResolveBoardProposalResult,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowRevertBoardProposalRpc = Rpc.make(WORKFLOW_WS_METHODS.revertBoardProposal, {
  payload: WorkflowRevertBoardProposalInput,
  success: WorkflowRevertBoardProposalResult,
  error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
});

export const WsWorkflowListImportableWorkItemsRpc = Rpc.make(
  WORKFLOW_WS_METHODS.listImportableWorkItems,
  {
    payload: Schema.Struct({ boardId: BoardId }),
    success: ListImportableWorkItemsResult,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsWorkflowImportWorkItemsRpc = Rpc.make(
  WORKFLOW_WS_METHODS.importWorkItems,
  {
    payload: Schema.Struct({
      boardId: BoardId,
      sourceId: Schema.String,
      externalIds: Schema.Array(Schema.String),
      destinationLane: Schema.optional(LaneKey),
    }),
    success: ImportWorkItemsResult,
    error: Schema.Union([WorkflowRpcError, EnvironmentAuthorizationError]),
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalAttachHistoryRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsWorkflowListBoardsRpc,
  WsWorkflowCreateBoardRpc,
  WsWorkflowDeleteBoardRpc,
  WsWorkflowRenameBoardRpc,
  WsWorkflowGetBoardRpc,
  WsWorkflowGetBoardDefinitionRpc,
  WsWorkflowSaveBoardDefinitionRpc,
  WsWorkflowImportBoardRpc,
  WsWorkflowCreateWorkflowBoardRpc,
  WsWorkflowGenerateWorkflowDraftRpc,
  WsWorkflowListBoardTemplatesRpc,
  WsWorkflowListBoardVersionsRpc,
  WsWorkflowGetBoardVersionRpc,
  WsWorkflowSubscribeBoardRpc,
  WsWorkflowCreateTicketRpc,
  WsWorkflowEditTicketRpc,
  WsWorkflowMoveTicketRpc,
  WsWorkflowRunLaneRpc,
  WsWorkflowResolveApprovalRpc,
  WsWorkflowAnswerTicketStepRpc,
  WsWorkflowPostTicketMessageRpc,
  WsWorkflowEditTicketMessageRpc,
  WsWorkflowSetProjectScriptTrustRpc,
  WsWorkflowCancelStepRpc,
  WsWorkflowGetTicketDetailRpc,
  WsWorkflowGetTicketDiffRpc,
  WsWorkflowIntakeTicketsRpc,
  WsWorkflowListTicketArtifactsRpc,
  WsWorkflowGetWebhookConfigRpc,
  WsWorkflowGetBoardDigestRpc,
  WsWorkflowGetBoardMetricsRpc,
  WsWorkflowDryRunBoardRpc,
  WsWorkflowListNeedsAttentionTicketsRpc,
  WsWorkflowListWorkSourceConnectionsRpc,
  WsWorkflowCreateWorkSourceConnectionRpc,
  WsWorkflowDeleteWorkSourceConnectionRpc,
  WsWorkflowListOutboundConnectionsRpc,
  WsWorkflowCreateOutboundConnectionRpc,
  WsWorkflowDeleteOutboundConnectionRpc,
  WsWorkflowProposeBoardImprovementRpc,
  WsWorkflowListBoardProposalsRpc,
  WsWorkflowGetBoardProposalRpc,
  WsWorkflowResolveBoardProposalRpc,
  WsWorkflowRevertBoardProposalRpc,
  WsWorkflowListImportableWorkItemsRpc,
  WsWorkflowImportWorkItemsRpc,
);
