import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { ProviderSetupError } from "./providerSetup.ts";
import { UsageSummaryInput, UsageSummary, UsageReadError, UsagePricing } from "./usage.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";
import {
  CollaborativeAcceptanceAssessmentSubmission,
  CollaborativeAcceptanceCaseLookupError,
  CollaborativeAcceptanceCaseLookupInput,
  CollaborativeAcceptanceCaseLookupResult,
  CollaborativeAcceptanceCandidateSubmission,
  CollaborativeAcceptanceCaseId,
  CollaborativeAcceptanceError,
  CollaborativeAcceptancePauseReason,
  CollaborativeAcceptanceStatus,
} from "./collaborativeAcceptance.ts";
import {
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ProviderUploadFeedbackError,
} from "./provider.ts";
import { ResourceTelemetrySnapshot } from "./resourceTelemetry.ts";
import { OpenError, OpenInEditorInput, RevealInFileManagerInput } from "./editor.ts";
import {
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
  EnvironmentRpcAuthorization,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceSession,
  DeviceServiceState,
  DeviceShutdownInput,
} from "./device.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentUploadSigningKeyError,
  AttachmentDeleteInput,
} from "./assets.ts";
import {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCheckoutResult,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitListOpenPullRequestsInput,
  GitListOpenPullRequestsResult,
  GitManagerServiceError,
  GitHubCliError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolveReviewChangesContextInput,
  GitResolveReviewChangesContextResult,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStatusInput,
  GitStatusLocalResult,
  GitStatusResult,
  GitStatusStreamEvent,
} from "./git.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffStateError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationReadThreadInputError,
  OrchestrationGetThreadActivitiesError,
  OrchestrationGetThreadActivitiesInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffStateError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationSearchTranscriptInput,
  OrchestrationSearchTranscriptResult,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileError,
  ProjectReadFileRpcInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesRpcInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
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
  TerminalAttachInput,
  TerminalAttachStreamEvent,
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
  ServerConfigStreamEvent,
  ServerConfig,
  ServerChatArchiveError,
  ServerExportActiveChatsInput,
  ServerExportActiveChatsResult,
  ServerExportThreadMarkdownError,
  ServerExportThreadMarkdownInput,
  ServerExportThreadMarkdownResult,
  ServerImportChatArchiveInput,
  ServerImportChatArchiveResult,
  ServerLifecycleStreamEvent,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerProviderListCommandsError,
  ServerProviderListCommandsInput,
  ServerProviderListCommandsResult,
  ServerProviderPrewarmSessionInput,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerProviderUpdatedPayload,
  ServerListSkillsResult,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import { SidebarStateError, SidebarStateMutation, SidebarStateSnapshot } from "./sidebarState.ts";
import {
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
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "./vcsRpc.ts";
import { VcsError } from "./vcs.ts";
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
import {
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import {
  PullRequestActionInput,
  PullRequestSummary,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestUpdateInput,
  PullRequestCommentUpdateInput,
  PullRequestReactionInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestActivity,
  PullRequestCommentInput,
  PullRequestDetail,
  PullRequestInvalidateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestRef,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
import {
  PullRequestMonitorContextInput,
  PullRequestMonitorContextResult,
  PullRequestMonitorError,
  PullRequestMonitorLaunchFallbackInput,
  PullRequestMonitorLaunchFallbackResult,
  PullRequestMonitorListInput,
  PullRequestMonitorListResult,
  PullRequestMonitorMutationResult,
  PullRequestMonitorReportInput,
  PullRequestMonitorReportResult,
  PullRequestMonitorStartInput,
  PullRequestMonitorStatusInput,
  PullRequestMonitorStatusResult,
  PullRequestMonitorStopInput,
  PullRequestMonitorSubmitFindingsInput,
  PullRequestMonitorSubmitFindingsResult,
  PullRequestMonitorTransferInput,
} from "./pullRequestMonitor.ts";
import { WorkflowRunError, WorkflowRunResult } from "./agentWorkflows.ts";
import { WorkflowRunInput } from "./workflowRuntime.ts";

export const WS_METHODS = {
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerUploadFeedback: "provider.uploadFeedback",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
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
  shellRevealInFileManager: "shell.revealInFileManager",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",
  assetsCreateUrl: "assets.createUrl",

  // Preview methods
  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewReportStatus: "preview.reportStatus",
  previewResize: "preview.resize",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",

  // Git methods
  gitPull: "git.pull",
  gitRefreshStatus: "git.refreshStatus",
  gitLocalStatus: "git.localStatus",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitListOpenPullRequests: "git.listOpenPullRequests",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  gitResolveReviewChangesContext: "git.resolveReviewChangesContext",
  gitPrewarmReviewChangesContext: "git.prewarmReviewChangesContext",

  // Vcs methods (upstream VCS driver foundation)
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Source control methods
  serverDiscoverSourceControl: "server.discoverSourceControl",
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",

  // Review methods
  reviewGetDiffPreview: "review.getDiffPreview",

  // Workflow methods
  workflowRun: "workflow.run",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverListProviderCommands: "server.listProviderCommands",
  serverPrewarmProviderSession: "server.prewarmProviderSession",
  serverListSkills: "server.listSkills",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverUpdateProvider: "server.updateProvider",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverExportActiveChats: "server.exportActiveChats",
  serverImportChatArchive: "server.importChatArchive",
  serverExportThreadMarkdown: "server.exportThreadMarkdown",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",

  // Sidebar state
  sidebarGetState: "sidebar.getState",
  sidebarUpdateState: "sidebar.updateState",

  // Device methods
  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  // Cloud environment methods
  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  // Pull request methods
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestMonitorsStart: "pullRequestMonitors.start",
  pullRequestMonitorsStop: "pullRequestMonitors.stop",
  pullRequestMonitorsStatus: "pullRequestMonitors.status",
  pullRequestMonitorsList: "pullRequestMonitors.list",
  pullRequestMonitorsSubscribe: "pullRequestMonitors.subscribe",
  pullRequestMonitorsContext: "pullRequestMonitors.context",
  pullRequestMonitorsReport: "pullRequestMonitors.report",
  pullRequestMonitorsTransfer: "pullRequestMonitors.transfer",
  pullRequestMonitorsSubmitFindings: "pullRequestMonitors.submitFindings",
  pullRequestMonitorsLaunchFallback: "pullRequestMonitors.launchFallback",

  collaborativeAcceptanceSubmitCandidate: "collaborativeAcceptance.submitCandidate",
  collaborativeAcceptanceRequestReview: "collaborativeAcceptance.requestReview",
  collaborativeAcceptanceStatus: "collaborativeAcceptance.status",
  collaborativeAcceptanceResolveForPullRequest: "collaborativeAcceptance.resolveForPullRequest",
  collaborativeAcceptanceSubmitAssessment: "collaborativeAcceptance.submitAssessment",
  collaborativeAcceptancePause: "collaborativeAcceptance.pause",
  collaborativeAcceptanceResume: "collaborativeAcceptance.resume",

  // Streaming subscriptions
  subscribeGitStatus: "subscribeGitStatus",
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeSidebarState: "subscribeSidebarState",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});

export const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
});

export const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
});

export const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    cwd: Schema.optional(Schema.String),
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
});

export const WsServerListProviderCommandsRpc = Rpc.make(WS_METHODS.serverListProviderCommands, {
  payload: ServerProviderListCommandsInput,
  success: ServerProviderListCommandsResult,
  error: ServerProviderListCommandsError,
});

export const WsServerPrewarmProviderSessionRpc = Rpc.make(WS_METHODS.serverPrewarmProviderSession, {
  payload: ServerProviderPrewarmSessionInput,
  success: Schema.Struct({}),
});

export const WsServerListSkillsRpc = Rpc.make(WS_METHODS.serverListSkills, {
  payload: Schema.Struct({}),
  success: ServerListSkillsResult,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsSidebarGetStateRpc = Rpc.make(WS_METHODS.sidebarGetState, {
  payload: Schema.Struct({}),
  success: SidebarStateSnapshot,
  error: SidebarStateError,
});

export const WsSidebarUpdateStateRpc = Rpc.make(WS_METHODS.sidebarUpdateState, {
  payload: SidebarStateMutation,
  success: SidebarStateSnapshot,
  error: SidebarStateError,
});

export const WsServerExportThreadMarkdownRpc = Rpc.make(WS_METHODS.serverExportThreadMarkdown, {
  payload: ServerExportThreadMarkdownInput,
  success: ServerExportThreadMarkdownResult,
  error: ServerExportThreadMarkdownError,
});

export const WsServerExportActiveChatsRpc = Rpc.make(WS_METHODS.serverExportActiveChats, {
  payload: ServerExportActiveChatsInput,
  success: ServerExportActiveChatsResult,
  error: ServerChatArchiveError,
});

export const WsServerImportChatArchiveRpc = Rpc.make(WS_METHODS.serverImportChatArchive, {
  payload: ServerImportChatArchiveInput,
  success: ServerImportChatArchiveResult,
  error: ServerChatArchiveError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesRpcInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: ProjectListEntriesError,
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileRpcInput,
  success: ProjectReadFileResult,
  error: ProjectReadFileError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsShellRevealInFileManagerRpc = Rpc.make(WS_METHODS.shellRevealInFileManager, {
  payload: RevealInFileManagerInput,
  error: OpenError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
});

export const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: AssetAccessError,
});

export const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: PreviewError,
});

export const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: PreviewError,
});

export const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: PreviewError,
});

export const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: PreviewError,
});

export const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: PreviewError,
});

// Idempotent: missing tabs are a no-op, so there is no error channel.
export const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: PreviewError,
});

export const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
});

export const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: PreviewAutomationError,
  stream: true,
});

export const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: PreviewAutomationError,
});

export const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
});

const PullRequestRpcError = Schema.Union([PullRequestUnavailableError, PullRequestOperationError]);

export const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

export const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

export const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSetThreadResolutionRpc = Rpc.make(
  WS_METHODS.pullRequestsSetThreadResolution,
  {
    payload: PullRequestThreadResolutionInput,
    success: Schema.Void,
    error: PullRequestRpcError,
  },
);

export const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsReviewerCandidatesRpc = Rpc.make(
  WS_METHODS.pullRequestsReviewerCandidates,
  {
    payload: PullRequestRef,
    success: PullRequestReviewerCandidateList,
    error: PullRequestRpcError,
  },
);

export const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestMonitorsStartRpc = Rpc.make(WS_METHODS.pullRequestMonitorsStart, {
  payload: PullRequestMonitorStartInput,
  success: PullRequestMonitorMutationResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsStopRpc = Rpc.make(WS_METHODS.pullRequestMonitorsStop, {
  payload: PullRequestMonitorStopInput,
  success: PullRequestMonitorMutationResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsStatusRpc = Rpc.make(WS_METHODS.pullRequestMonitorsStatus, {
  payload: PullRequestMonitorStatusInput,
  success: PullRequestMonitorStatusResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsListRpc = Rpc.make(WS_METHODS.pullRequestMonitorsList, {
  payload: PullRequestMonitorListInput,
  success: PullRequestMonitorListResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsSubscribeRpc = Rpc.make(WS_METHODS.pullRequestMonitorsSubscribe, {
  payload: PullRequestMonitorListInput,
  success: PullRequestMonitorListResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsPullRequestMonitorsContextRpc = Rpc.make(WS_METHODS.pullRequestMonitorsContext, {
  payload: PullRequestMonitorContextInput,
  success: PullRequestMonitorContextResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsReportRpc = Rpc.make(WS_METHODS.pullRequestMonitorsReport, {
  payload: PullRequestMonitorReportInput,
  success: PullRequestMonitorReportResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsTransferRpc = Rpc.make(WS_METHODS.pullRequestMonitorsTransfer, {
  payload: PullRequestMonitorTransferInput,
  success: PullRequestMonitorMutationResult,
  error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
});

export const WsPullRequestMonitorsSubmitFindingsRpc = Rpc.make(
  WS_METHODS.pullRequestMonitorsSubmitFindings,
  {
    payload: PullRequestMonitorSubmitFindingsInput,
    success: PullRequestMonitorSubmitFindingsResult,
    error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
  },
);

export const WsPullRequestMonitorsLaunchFallbackRpc = Rpc.make(
  WS_METHODS.pullRequestMonitorsLaunchFallback,
  {
    payload: PullRequestMonitorLaunchFallbackInput,
    success: PullRequestMonitorLaunchFallbackResult,
    error: Schema.Union([PullRequestMonitorError, EnvironmentAuthorizationError]),
  },
);

const CollaborativeAcceptanceCaseInput = Schema.Struct({
  threadId: ThreadId,
  caseId: CollaborativeAcceptanceCaseId,
});

export const WsCollaborativeAcceptanceSubmitCandidateRpc = Rpc.make(
  WS_METHODS.collaborativeAcceptanceSubmitCandidate,
  {
    payload: Schema.Struct({
      threadId: ThreadId,
      submission: CollaborativeAcceptanceCandidateSubmission,
    }),
    success: CollaborativeAcceptanceStatus,
    error: CollaborativeAcceptanceError,
  },
);

export const WsCollaborativeAcceptanceRequestReviewRpc = Rpc.make(
  WS_METHODS.collaborativeAcceptanceRequestReview,
  {
    payload: CollaborativeAcceptanceCaseInput,
    success: CollaborativeAcceptanceStatus,
    error: CollaborativeAcceptanceError,
  },
);

export const WsCollaborativeAcceptanceStatusRpc = Rpc.make(
  WS_METHODS.collaborativeAcceptanceStatus,
  {
    payload: CollaborativeAcceptanceCaseInput,
    success: CollaborativeAcceptanceStatus,
    error: CollaborativeAcceptanceError,
  },
);

export const WsCollaborativeAcceptanceResolveForPullRequestRpc = Rpc.make(
  WS_METHODS.collaborativeAcceptanceResolveForPullRequest,
  {
    payload: CollaborativeAcceptanceCaseLookupInput,
    success: CollaborativeAcceptanceCaseLookupResult,
    error: CollaborativeAcceptanceCaseLookupError,
  },
);

export const WsCollaborativeAcceptanceSubmitAssessmentRpc = Rpc.make(
  WS_METHODS.collaborativeAcceptanceSubmitAssessment,
  {
    payload: Schema.Struct({
      threadId: ThreadId,
      submission: CollaborativeAcceptanceAssessmentSubmission,
    }),
    success: CollaborativeAcceptanceStatus,
    error: CollaborativeAcceptanceError,
  },
);

export const WsCollaborativeAcceptancePauseRpc = Rpc.make(WS_METHODS.collaborativeAcceptancePause, {
  payload: Schema.Struct({
    ...CollaborativeAcceptanceCaseInput.fields,
    reason: CollaborativeAcceptancePauseReason,
  }),
  success: CollaborativeAcceptanceStatus,
  error: CollaborativeAcceptanceError,
});

export const WsCollaborativeAcceptanceResumeRpc = Rpc.make(
  WS_METHODS.collaborativeAcceptanceResume,
  {
    payload: CollaborativeAcceptanceCaseInput,
    success: CollaborativeAcceptanceStatus,
    error: CollaborativeAcceptanceError,
  },
);

export const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(
  WS_METHODS.subscribeDiscoveredLocalServers,
  {
    payload: Schema.Struct({}),
    success: DiscoveredLocalServerList,
    stream: true,
  },
);

export const WsSubscribeGitStatusRpc = Rpc.make(WS_METHODS.subscribeGitStatus, {
  payload: GitStatusInput,
  success: GitStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: GitCommandError,
});

export const WsGitRefreshStatusRpc = Rpc.make(WS_METHODS.gitRefreshStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

export const WsGitLocalStatusRpc = Rpc.make(WS_METHODS.gitLocalStatus, {
  payload: GitStatusInput,
  success: GitStatusLocalResult,
  error: GitManagerServiceError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitListOpenPullRequestsRpc = Rpc.make(WS_METHODS.gitListOpenPullRequests, {
  payload: GitListOpenPullRequestsInput,
  success: GitListOpenPullRequestsResult,
  error: GitHubCliError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitResolveReviewChangesContextRpc = Rpc.make(
  WS_METHODS.gitResolveReviewChangesContext,
  {
    payload: GitResolveReviewChangesContextInput,
    success: GitResolveReviewChangesContextResult,
    error: GitCommandError,
  },
);

/**
 * Acknowledges only: the captured context can reach several megabytes, and
 * returning it to a browser that discards it would spend the latency this call
 * exists to remove on the socket the ensuing run needs.
 */
export const WsGitPrewarmReviewChangesContextRpc = Rpc.make(
  WS_METHODS.gitPrewarmReviewChangesContext,
  {
    payload: GitResolveReviewChangesContextInput,
    error: GitCommandError,
  },
);

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitCommandError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitCommandError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  success: GitCreateBranchResult,
  error: GitCommandError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  success: GitCheckoutResult,
  error: GitCommandError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitCommandError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetThreadActivitiesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadActivities,
  {
    payload: OrchestrationGetThreadActivitiesInput,
    success: OrchestrationRpcSchemas.getThreadActivities.output,
    error: OrchestrationGetThreadActivitiesError,
  },
);

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationGetTurnDiffStateRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getTurnDiffState,
  {
    payload: OrchestrationRpcSchemas.getTurnDiffState.input,
    success: OrchestrationRpcSchemas.getTurnDiffState.output,
    error: OrchestrationGetTurnDiffStateError,
  },
);

export const WsOrchestrationGetFullThreadDiffStateRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiffState,
  {
    payload: OrchestrationRpcSchemas.getFullThreadDiffState.input,
    success: OrchestrationRpcSchemas.getFullThreadDiffState.output,
    error: OrchestrationGetFullThreadDiffStateError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});
export const WsOrchestrationSearchTranscriptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.searchTranscript,
  {
    payload: OrchestrationSearchTranscriptInput,
    success: OrchestrationSearchTranscriptResult,
    error: OrchestrationGetSnapshotError,
  },
);
export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationSearchThreadsResult,
  error: OrchestrationGetSnapshotError,
});

export const WsOrchestrationGetShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getShellSnapshot.input,
    success: OrchestrationRpcSchemas.getShellSnapshot.output,
    error: OrchestrationGetSnapshotError,
  },
);

export const WsOrchestrationGetThreadSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadSnapshot,
  {
    payload: OrchestrationRpcSchemas.getThreadSnapshot.input,
    success: OrchestrationRpcSchemas.getThreadSnapshot.output,
    error: OrchestrationGetSnapshotError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  stream: true,
});

export const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  stream: true,
});

export const WsSubscribeSidebarStateRpc = Rpc.make(WS_METHODS.subscribeSidebarState, {
  payload: Schema.Struct({}),
  success: SidebarStateSnapshot,
  error: SidebarStateError,
  stream: true,
});

export const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: GitCommandError,
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: GitManagerServiceError,
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: GitCommandError,
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: GitCommandError,
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: GitCommandError,
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: GitCommandError,
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: VcsError,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

export const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: DeviceError,
});

export const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: DeviceError,
});

export const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: DeviceError,
});

export const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: DeviceError,
});

export const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: DeviceError,
});

export const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: DeviceError,
});

export const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: DeviceError,
});

export const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  stream: true,
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: SourceControlRepositoryError,
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: SourceControlRepositoryError,
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: SourceControlRepositoryError,
  },
);

export const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: ReviewDiffPreviewError,
});

export const WsWorkflowRunRpc = Rpc.make(WS_METHODS.workflowRun, {
  payload: WorkflowRunInput,
  success: WorkflowRunResult,
  error: WorkflowRunError,
});

export const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
});

export const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: RelayClientInstallFailedError,
  stream: true,
});

export const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: TerminalError,
  stream: true,
});

export const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  stream: true,
});

export const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: ServerProviderUpdateError,
});

export const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
});

export const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
});

export const WsServerGetProcessResourceHistoryRpc = Rpc.make(
  WS_METHODS.serverGetProcessResourceHistory,
  {
    payload: ServerProcessResourceHistoryInput,
    success: ServerProcessResourceHistoryResult,
  },
);

export const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
});

export const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: OrchestrationGetSnapshotError,
  },
);

export const WsRpcGroup = RpcGroup.make(
  Rpc.make(ORCHESTRATION_WS_METHODS.readThread, {
    payload: OrchestrationRpcSchemas.readThread.input,
    success: OrchestrationRpcSchemas.readThread.output,
    error: Schema.Union([OrchestrationReadThreadInputError, OrchestrationGetSnapshotError]),
  }),
  WsServerProbeRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerListProviderCommandsRpc,
  WsServerPrewarmProviderSessionRpc,
  WsServerListSkillsRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsSidebarGetStateRpc,
  WsSidebarUpdateStateRpc,
  WsServerExportActiveChatsRpc,
  WsServerImportChatArchiveRpc,
  WsServerExportThreadMarkdownRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsWriteFileRpc,
  WsShellOpenInEditorRpc,
  WsShellRevealInFileManagerRpc,
  WsFilesystemBrowseRpc,
  WsAssetsCreateUrlRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewReportStatusRpc,
  WsPreviewResizeRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestMonitorsStartRpc,
  WsPullRequestMonitorsStopRpc,
  WsPullRequestMonitorsStatusRpc,
  WsPullRequestMonitorsListRpc,
  WsPullRequestMonitorsSubscribeRpc,
  WsPullRequestMonitorsContextRpc,
  WsPullRequestMonitorsReportRpc,
  WsPullRequestMonitorsTransferRpc,
  WsPullRequestMonitorsSubmitFindingsRpc,
  WsPullRequestMonitorsLaunchFallbackRpc,
  WsCollaborativeAcceptanceSubmitCandidateRpc,
  WsCollaborativeAcceptanceRequestReviewRpc,
  WsCollaborativeAcceptanceStatusRpc,
  WsCollaborativeAcceptanceResolveForPullRequestRpc,
  WsCollaborativeAcceptanceSubmitAssessmentRpc,
  WsCollaborativeAcceptancePauseRpc,
  WsCollaborativeAcceptanceResumeRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeGitStatusRpc,
  WsGitPullRpc,
  WsGitRefreshStatusRpc,
  WsGitLocalStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitListOpenPullRequestsRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitResolveReviewChangesContextRpc,
  WsGitPrewarmReviewChangesContextRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeSidebarStateRpc,
  WsSubscribePreviewEventsRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetThreadActivitiesRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetTurnDiffStateRpc,
  WsOrchestrationGetFullThreadDiffStateRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationSearchTranscriptRpc,
  WsOrchestrationGetShellSnapshotRpc,
  WsOrchestrationGetThreadSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsSubscribeVcsStatusRpc,
  WsServerDiscoverSourceControlRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsReviewGetDiffPreviewRpc,
  WsWorkflowRunRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsTerminalAttachRpc,
  WsSubscribeTerminalMetadataRpc,
  WsServerRemoveKeybindingRpc,
  WsServerUpdateProviderRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerSignalProcessRpc,
).middleware(EnvironmentRpcAuthorization);

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

export const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: ProviderSetupRpcError,
});

export const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

export const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

export const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

export const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

export const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(
  WS_METHODS.pullRequestsSubscribeRefreshes,
  {
    payload: Schema.Struct({}),
    success: NonNegativeInt,
    error: EnvironmentAuthorizationError,
    stream: true,
  },
);

export const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

export const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

export const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

export const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

export const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

export const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});
