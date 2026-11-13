import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  GuestShareCreateError,
  GuestShareCreateInput,
  GuestShareCreateResult,
} from "./guestShare.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetWorkflowScriptError,
  OrchestrationV2GetNativeChildWorkError,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2ForceStopThreadError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2CommandOutputError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
} from "./orchestrationV2.ts";
import { TerminalMetadataStreamEvent } from "./terminal.ts";
import { ServerConfigStreamEvent, ServerLifecycleStreamEvent } from "./server.ts";
import { ResourceTelemetrySnapshot } from "./resourceTelemetry.ts";
import { ServerSettingsError } from "./settings.ts";
import {
  ScheduledTaskDeleteInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskError,
  ScheduledTaskListInput,
  ScheduledTaskListResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRotateWebhookTokenInput,
  ScheduledTaskListWebhookDeliveriesInput,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskGetWebhookDeliveryInput,
  ScheduledTaskGetWebhookDeliveryResult,
  ScheduledTaskRunNowResult,
  ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
  ScheduledTaskMutationResult,
} from "./scheduledTask.ts";
import { SecretRequestAnswerInput, SecretRequestError } from "./secretRequest.ts";
import { WS_METHODS, WsChatGptHandoffSubscribeRpc, WsChatGptImportProfileRpc, WsChatGptReconnectProfileRpc, WsPeerLinksAnswerRequestRpc, WsPeerLinksLinkRpc, WsPeerLinksListRpc, WsPeerLinksUnlinkRpc, WsProviderAuthCancelRpc, WsProviderAuthCompleteRpc, WsProviderAuthLogoutRpc, WsProviderAuthRespondRpc, WsProviderAuthStartRpc, WsProviderAuthSubscribeRpc, WsProviderConsumeResetCreditRpc, WsProviderInstallCancelRpc, WsProviderInstallRemoveRpc, WsProviderInstallStartRpc, WsProviderInstallSubscribeRpc, WsServerCommitDesktopUpdateRpc, WsServerGetConfigRpc, WsServerGetDatabaseStorageRpc, WsServerGetNpmReleaseRpc, WsServerGetStorageCleanupReportRpc, WsServerProbeRpc, WsServerRefreshProvidersRpc, WsServerRemoveKeybindingRpc, WsServerRunStorageCleanupRpc, WsServerUpdateProviderRpc, WsServerUpdateServerRpc, WsServerUpdateServerWithProgressRpc, WsServerUpdateSettingsRpc, WsServerUpsertKeybindingRpc } from "./rpcPart2.ts";
import { WsCloudGetRelayClientStatusRpc, WsCloudInstallRelayClientRpc, WsProjectCloneCancelRpc, WsProjectCloneRetryRpc, WsProjectCloneStartRpc, WsPullRequestsActivityRpc, WsPullRequestsChangeBreakdownRpc, WsPullRequestsChecksRpc, WsPullRequestsCommentRpc, WsPullRequestsDetailRpc, WsPullRequestsDiffFileContentsRpc, WsPullRequestsFilesViewedRpc, WsPullRequestsFilterOptionsRpc, WsPullRequestsGenerateReviewGuideRpc, WsPullRequestsInvalidateRpc, WsPullRequestsLabelCandidatesRpc, WsPullRequestsLinkedThreadsRpc, WsPullRequestsListRpc, WsPullRequestsListStatsRpc, WsPullRequestsPreviewRpc, WsPullRequestsReplyToThreadRpc, WsPullRequestsReportStateRpc, WsPullRequestsRequestReviewersRpc, WsPullRequestsReviewGuideRpc, WsPullRequestsReviewerCandidatesRpc, WsPullRequestsRoutingIdentityRpc, WsPullRequestsRoutingRpc, WsPullRequestsRunActionRpc, WsPullRequestsSetFilesViewedRpc, WsPullRequestsSetLabelsRpc, WsPullRequestsSetReactionRpc, WsPullRequestsSetThreadResolutionRpc, WsPullRequestsStackRpc, WsPullRequestsSubmitReviewRpc, WsPullRequestsSubscribeRefreshesRpc, WsPullRequestsSummaryRpc, WsPullRequestsThreadCommentsRpc, WsPullRequestsUpdateCommentRpc, WsPullRequestsUpdateRpc, WsServerAcceptAcpRegistryUrlAuthRpc, WsServerCheckOtlpEndpointRpc, WsServerDeleteAcpRegistrySessionRpc, WsServerDisableAcpRegistryProviderRpc, WsServerDiscoverSourceControlRpc, WsServerGetHostResourcesRpc, WsServerGetProcessDiagnosticsRpc, WsServerGetProcessResourceHistoryRpc, WsServerGetResourceTelemetryHistoryRpc, WsServerGetTraceDiagnosticsRpc, WsServerGetUsageSummaryRpc, WsServerImportAcpRegistrySessionRpc, WsServerListAcpRegistryProvidersRpc, WsServerListAcpRegistrySessionsRpc, WsServerLogoutAcpRegistryRpc, WsServerPrepareAcpRegistryAgentRpc, WsServerPrepareTriageRpc, WsServerRefreshUsageRatesRpc, WsServerReportClientActivityRpc, WsServerRetryResourceTelemetryRpc, WsServerSearchAcpRegistryRpc, WsServerSetAcpRegistryProviderRpc, WsServerSignalProcessRpc, WsServerUninstallAcpRegistryManagedBinaryRpc, WsSourceControlAppAccessRpc, WsSourceControlCloneRepositoryRpc, WsSourceControlLookupRepositoryRpc, WsSourceControlPublishRepositoryRpc, WsSourceControlSignInCancelRpc, WsSourceControlSignInStartRpc, WsSourceControlSignInWaitRpc, WsSourceControlStarRpc, WsSourceControlStarredRpc, WsSubscribeProjectClonesRpc } from "./rpcPart3.ts";
import { WsAgentSessionsImportRpc, WsAgentSessionsScanRpc, WsAssetsCreateUrlRpc, WsAssetsPersistChatAttachmentsRpc, WsAttachmentsCreateUploadUrlRpc, WsAttachmentsDeleteRpc, WsDeviceActionRpc, WsDeviceCloseRpc, WsDeviceConfigureRpc, WsDeviceDetailRpc, WsDeviceEasAccountRpc, WsDeviceListRpc, WsDeviceOpenRpc, WsDeviceShutdownRpc, WsDeviceSimlockIdentityRpc, WsDeviceTestHostRpc, WsFilesystemBrowseRpc, WsFilesystemGetMetadataRpc, WsGitPreparePullRequestThreadRpc, WsGitResolvePullRequestRpc, WsGitRunStackedActionRpc, WsMcpAppsCallToolRpc, WsMcpAppsReadResourceRpc, WsMcpAppsToolInfoRpc, WsMcpAppsUpdateModelContextRpc, WsOrchestrationV2DispatchCommandRpc, WsOrchestrationV2GetArchivedShellSnapshotRpc, WsOrchestrationV2GetFullThreadDiffRpc, WsOrchestrationV2GetTurnDiffRpc, WsOrchestrationV2SearchThreadRpc, WsOrchestrationV2SearchThreadStreamRpc, WsOrchestrationV2SearchThreadsRpc, WsPreviewAdjustRpc, WsPreviewClearProfileRpc, WsPreviewCloseRpc, WsPreviewListRpc, WsPreviewOpenRpc, WsPreviewReportProfilesRpc, WsPreviewReportStatusRpc, WsPreviewResizeRpc, WsPreviewStopLocalServerRpc, WsProjectsCreateFromThreadRpc, WsProjectsCreateNewRpc, WsProjectsEnsureScratchRpc, WsProjectsListEntriesRpc, WsProjectsListIgnoredFilesRpc, WsProjectsMutateRpc, WsProjectsReadFileRpc, WsProjectsSearchContentsRpc, WsProjectsSearchEntriesRpc, WsProjectsWriteFileRpc, WsProviderUploadFeedbackRpc, WsReviewGetBranchCommitsRpc, WsReviewGetDiffFileContentsRpc, WsReviewGetDiffPreviewRpc, WsShellOpenInEditorRpc, WsSubscribeDeviceStateRpc, WsSubscribeDiscoveredLocalServersRpc, WsSubscribePreviewEventsRpc, WsSubscribeVcsStatusRpc, WsSubscribeWorktreeSetupRpc, WsTerminalAttachRpc, WsTerminalClearRpc, WsTerminalCloseRpc, WsTerminalObserveRpc, WsTerminalOpenRpc, WsTerminalResizeRpc, WsTerminalWriteRpc, WsVcsCreateRefRpc, WsVcsCreateWorktreeRpc, WsVcsInitRpc, WsVcsListRefsRpc, WsVcsPullRpc, WsVcsRefreshStatusRpc, WsVcsRemoveWorktreeRpc, WsVcsSwitchRefRpc, WsWorktreeSetupCancelRpc } from "./rpcPart4.ts";
export {
  WS_METHODS,
  WsServerRefreshProvidersRpc,
} from "./rpcPart2.ts";

const WsOrchestrationV2GetThreadFamilyRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
  payload: OrchestrationV2RpcSchemas.getThreadFamily.input,
  success: OrchestrationV2RpcSchemas.getThreadFamily.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetWorktreeThreadIdsRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
  {
    payload: OrchestrationV2RpcSchemas.getWorktreeThreadIds.input,
    success: OrchestrationV2RpcSchemas.getWorktreeThreadIds.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetOlderSettledThreadsRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads,
  {
    payload: OrchestrationV2RpcSchemas.getOlderSettledThreads.input,
    success: OrchestrationV2RpcSchemas.getOlderSettledThreads.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetThreadProjectionRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2StopWorkflowRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.stopWorkflow, {
  payload: OrchestrationV2RpcSchemas.stopWorkflow.input,
  success: OrchestrationV2RpcSchemas.stopWorkflow.output,
  error: Schema.Union([OrchestrationV2StopWorkflowError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2ForceStopThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.forceStopThread, {
  payload: OrchestrationV2RpcSchemas.forceStopThread.input,
  success: OrchestrationV2RpcSchemas.forceStopThread.output,
  error: Schema.Union([OrchestrationV2ForceStopThreadError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationV2RpcSchemas.getWorkflowScript.input,
    success: OrchestrationV2RpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetNativeChildWorkRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getNativeChildWork,
  {
    payload: OrchestrationV2RpcSchemas.getNativeChildWork.input,
    success: OrchestrationV2RpcSchemas.getNativeChildWork.output,
    error: Schema.Union([OrchestrationV2GetNativeChildWorkError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetTurnItemRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
  payload: OrchestrationV2RpcSchemas.getTurnItem.input,
  success: OrchestrationV2RpcSchemas.getTurnItem.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2LaunchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
  payload: OrchestrationV2RpcSchemas.launchThread.input,
  success: OrchestrationV2RpcSchemas.launchThread.output,
  error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SubscribeShellRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
  payload: OrchestrationV2RpcSchemas.subscribeShell.input,
  success: OrchestrationV2RpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
  payload: OrchestrationV2RpcSchemas.subscribeThread.input,
  success: OrchestrationV2RpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeCommandOutputRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  {
    payload: OrchestrationV2RpcSchemas.subscribeCommandOutput.input,
    success: OrchestrationV2RpcSchemas.subscribeCommandOutput.output,
    error: Schema.Union([OrchestrationV2CommandOutputError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /** Opt-in protects older clients that reject unknown theme event types. */
    environmentThemes: Schema.optional(Schema.Boolean),
    usageLimitSources: Schema.optional(Schema.Boolean),
    /** Advertise client handling before the server offers /usage-limits, or older clients send it as a prompt. */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
    /** Omit per-cwd provider snapshots; the client fetches its cwd through `server.refreshProviders`. */
    workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsScheduledTasksSubscribeRpc = Rpc.make(WS_METHODS.scheduledTasksSubscribe, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsScheduledTasksUpsertRpc = Rpc.make(WS_METHODS.scheduledTasksUpsert, {
  payload: ScheduledTaskUpsertInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksSetEnabledRpc = Rpc.make(WS_METHODS.scheduledTasksSetEnabled, {
  payload: ScheduledTaskSetEnabledInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksDeleteRpc = Rpc.make(WS_METHODS.scheduledTasksDelete, {
  payload: ScheduledTaskDeleteInput,
  success: ScheduledTaskDeleteResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRunNowRpc = Rpc.make(WS_METHODS.scheduledTasksRunNow, {
  payload: ScheduledTaskRunNowInput,
  success: ScheduledTaskRunNowResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRotateWebhookTokenRpc = Rpc.make(
  WS_METHODS.scheduledTasksRotateWebhookToken,
  {
    payload: ScheduledTaskRotateWebhookTokenInput,
    success: ScheduledTaskMutationResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsGuestShareCreateRpc = Rpc.make(WS_METHODS.guestShareCreate, {
  payload: GuestShareCreateInput,
  success: GuestShareCreateResult,
  error: Schema.Union([GuestShareCreateError, EnvironmentAuthorizationError]),
});

const WsSecretsAnswerRequestRpc = Rpc.make(WS_METHODS.secretsAnswerRequest, {
  payload: SecretRequestAnswerInput,
  error: Schema.Union([SecretRequestError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListWebhookDeliveriesRpc = Rpc.make(
  WS_METHODS.scheduledTasksListWebhookDeliveries,
  {
    payload: ScheduledTaskListWebhookDeliveriesInput,
    success: ScheduledTaskListWebhookDeliveriesResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsScheduledTasksGetWebhookDeliveryRpc = Rpc.make(
  WS_METHODS.scheduledTasksGetWebhookDelivery,
  {
    payload: ScheduledTaskGetWebhookDeliveryInput,
    success: ScheduledTaskGetWebhookDeliveryResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export class RpcScopeAuthorization extends RpcMiddleware.Service<RpcScopeAuthorization>()(
  "t3/contracts/RpcScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

export const WsRpcGroup = RpcGroup.make(
  WsGuestShareCreateRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsChatGptReconnectProfileRpc,
  WsChatGptImportProfileRpc,
  WsChatGptHandoffSubscribeRpc,
  WsProviderAuthRespondRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerGetNpmReleaseRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerRunStorageCleanupRpc,
  WsServerGetStorageCleanupReportRpc,
  WsServerGetDatabaseStorageRpc,
  WsServerUpdateSettingsRpc,
  WsPeerLinksListRpc,
  WsPeerLinksLinkRpc,
  WsPeerLinksUnlinkRpc,
  WsPeerLinksAnswerRequestRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerSearchAcpRegistryRpc,
  WsServerPrepareAcpRegistryAgentRpc,
  WsServerUninstallAcpRegistryManagedBinaryRpc,
  WsServerAcceptAcpRegistryUrlAuthRpc,
  WsServerListAcpRegistrySessionsRpc,
  WsServerImportAcpRegistrySessionRpc,
  WsServerDeleteAcpRegistrySessionRpc,
  WsServerListAcpRegistryProvidersRpc,
  WsServerSetAcpRegistryProviderRpc,
  WsServerDisableAcpRegistryProviderRpc,
  WsServerLogoutAcpRegistryRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerCheckOtlpEndpointRpc,
  WsServerPrepareTriageRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsScheduledTasksSubscribeRpc,
  WsScheduledTasksUpsertRpc,
  WsScheduledTasksSetEnabledRpc,
  WsScheduledTasksDeleteRpc,
  WsScheduledTasksRunNowRpc,
  WsScheduledTasksRotateWebhookTokenRpc,
  WsSecretsAnswerRequestRpc,
  WsScheduledTasksListWebhookDeliveriesRpc,
  WsScheduledTasksGetWebhookDeliveryRpc,
  WsServerReportClientActivityRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsFilterOptionsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPreviewRpc,
  WsPullRequestsChecksRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsReviewGuideRpc,
  WsPullRequestsGenerateReviewGuideRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsFilesViewedRpc,
  WsPullRequestsChangeBreakdownRpc,
  WsPullRequestsSetFilesViewedRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReportStateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsSourceControlSignInStartRpc,
  WsSourceControlSignInWaitRpc,
  WsSourceControlSignInCancelRpc,
  WsSourceControlAppAccessRpc,
  WsSourceControlStarredRpc,
  WsSourceControlStarRpc,
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsListIgnoredFilesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsEnsureScratchRpc,
  WsProjectsCreateNewRpc,
  WsProjectsCreateFromThreadRpc,
  WsProjectsWriteFileRpc,
  WsProjectsMutateRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsFilesystemGetMetadataRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAssetsCreateUrlRpc,
  WsAssetsPersistChatAttachmentsRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsMcpAppsCallToolRpc,
  WsMcpAppsToolInfoRpc,
  WsMcpAppsReadResourceRpc,
  WsMcpAppsUpdateModelContextRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
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
  WsReviewGetBranchCommitsRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalObserveRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewResizeRpc,
  WsPreviewAdjustRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewClearProfileRpc,
  WsPreviewReportProfilesRpc,
  WsPreviewReportStatusRpc,
  WsSubscribePreviewEventsRpc,
  WsPreviewStopLocalServerRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceEasAccountRpc,
  WsDeviceSimlockIdentityRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationV2DispatchCommandRpc,
  WsOrchestrationV2GetWorkflowScriptRpc,
  WsOrchestrationV2GetNativeChildWorkRpc,
  WsOrchestrationV2StopWorkflowRpc,
  WsOrchestrationV2ForceStopThreadRpc,
  WsOrchestrationV2GetTurnItemRpc,
  WsOrchestrationV2GetTurnDiffRpc,
  WsOrchestrationV2GetFullThreadDiffRpc,
  WsOrchestrationV2SearchThreadsRpc,
  WsOrchestrationV2SearchThreadRpc,
  WsOrchestrationV2SearchThreadStreamRpc,
  WsOrchestrationV2GetArchivedShellSnapshotRpc,
  WsOrchestrationV2GetThreadFamilyRpc,
  WsOrchestrationV2GetWorktreeThreadIdsRpc,
  WsOrchestrationV2GetOlderSettledThreadsRpc,
  WsOrchestrationV2GetThreadProjectionRpc,
  WsOrchestrationV2LaunchThreadRpc,
  WsOrchestrationV2SubscribeShellRpc,
  WsOrchestrationV2SubscribeThreadRpc,
  WsOrchestrationV2SubscribeCommandOutputRpc,
).middleware(RpcScopeAuthorization);
