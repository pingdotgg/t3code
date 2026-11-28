import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  TeamAssignProjectInput,
  TeamAttachEnvironmentInput,
  TeamAutomationGitHubIdentity,
  TeamCancelGitHubDeviceFlowInput,
  TeamCancelGitHubDeviceFlowResult,
  TeamClearAutomationGitHubResult,
  TeamClearGitHubAppConfigResult,
  TeamCompleteGitHubOAuthInput,
  TeamConnectMyGitHubInput,
  TeamConsumeAcceptedNotesInput,
  TeamConsumeAcceptedNotesResult,
  TeamCreateInviteInput,
  TeamCreateMobilePairingLinkInput,
  TeamCreateMobilePairingLinkResult,
  TeamCreateThreadNoteInput,
  TeamCreateViewInput,
  TeamDeletePrepromptInput,
  TeamDeletePrepromptResult,
  TeamDeleteInput,
  TeamDeleteProviderInput,
  TeamDeleteProviderResult,
  TeamDeleteResult,
  TeamDeleteSkillInput,
  TeamDeleteSkillResult,
  TeamDeleteThreadNoteInput,
  TeamDeleteThreadNoteResult,
  TeamDeleteViewInput,
  TeamDeleteViewResult,
  TeamDetachEnvironmentInput,
  TeamDetachEnvironmentResult,
  TeamDisconnectMyGitHubResult,
  TeamEditThreadNoteInput,
  TeamEnvironment,
  TeamGitHubAppConfig,
  TeamGitHubIdentity,
  TeamInitializeInput,
  TeamInitializeResult,
  TeamInviteCreatedResult,
  TeamIssueLocalSyncTokenResult,
  TeamLeaveResult,
  TeamListFollowedThreadsResult,
  TeamListMyMobilePairingLinksResult,
  TeamListProviderUsageResult,
  TeamListThreadAttributionsResult,
  TeamListThreadNotesInput,
  TeamListThreadNotesResult,
  TeamMember,
  TeamNotifyLocalAssetsUpdatedInput,
  TeamNotifyLocalAssetsUpdatedResult,
  TeamOperationError,
  TeamPollGitHubDeviceFlowInput,
  TeamPollGitHubDeviceFlowResult,
  TeamPreprompt,
  TeamProjectAssignment,
  TeamProvider,
  TeamReleaseAcceptedNotesInput,
  TeamReleaseAcceptedNotesResult,
  TeamRemoveLocalBindingInput,
  TeamRemoveLocalBindingResult,
  TeamReserveAcceptedNotesInput,
  TeamReserveAcceptedNotesResult,
  TeamResolveThreadNoteInput,
  TeamRevokeInviteInput,
  TeamRevokeInviteResult,
  TeamRevokeMobilePairingLinkInput,
  TeamRevokeMobilePairingLinkResult,
  TeamSetAutomationGitHubInput,
  TeamSetGitHubAppConfigInput,
  TeamSetThreadLockedInput,
  TeamSetThreadViewInput,
  TeamSkill,
  TeamStartGitHubDeviceFlowInput,
  TeamStartGitHubDeviceFlowResult,
  TeamStartGitHubOAuthInput,
  TeamStartGitHubOAuthResult,
  TeamStateSnapshot,
  TeamStateStreamEvent,
  TeamSyncLocalBindingInput,
  TeamSyncLocalBindingResult,
  TeamSyncLocalThreadInput,
  TeamSyncLocalThreadResult,
  TeamThreadAttribution,
  TeamThreadFollowInput,
  TeamThreadFollowResult,
  TeamThreadNote,
  TeamUnassignProjectInput,
  TeamUnassignProjectResult,
  TeamUpdateDisplayNameInput,
  TeamUpdateEnvironmentInput,
  TeamUpdateMemberRoleInput,
  TeamUpdateMemberStatusInput,
  TeamUpdateMyMobileVisibilityInput,
  TeamUpdateMyPseudoInput,
  TeamUpdateViewInput,
  TeamUpsertPrepromptInput,
  TeamUpsertProviderInput,
  TeamUpsertSkillInput,
  TeamView,
  TeamWorkspace,
} from "./schemas.ts";

export const TEAM_WS_METHODS = {
  teamGetState: "team.getState",
  teamSubscribeState: "team.subscribeState",
  teamInitialize: "team.initialize",
  teamLeave: "team.leave",
  teamDelete: "team.delete",
  teamUpdateDisplayName: "team.updateDisplayName",
  teamUpdateMyPseudo: "team.updateMyPseudo",
  teamUpdateMemberRole: "team.updateMemberRole",
  teamUpdateMemberStatus: "team.updateMemberStatus",
  teamCreateInvite: "team.createInvite",
  teamRevokeInvite: "team.revokeInvite",
  teamCreateView: "team.createView",
  teamUpdateView: "team.updateView",
  teamDeleteView: "team.deleteView",
  teamSetThreadView: "team.setThreadView",
  teamSetThreadLocked: "team.setThreadLocked",
  teamListThreadAttributions: "team.listThreadAttributions",
  teamFollowThread: "team.followThread",
  teamUnfollowThread: "team.unfollowThread",
  teamListFollowedThreads: "team.listFollowedThreads",
  teamAssignProject: "team.assignProject",
  teamUnassignProject: "team.unassignProject",
  teamAttachEnvironment: "team.attachEnvironment",
  teamUpdateEnvironment: "team.updateEnvironment",
  teamDetachEnvironment: "team.detachEnvironment",
  teamSyncLocalThread: "team.syncLocalThread",
  teamCreateThreadNote: "team.createThreadNote",
  teamDeleteThreadNote: "team.deleteThreadNote",
  teamResolveThreadNote: "team.resolveThreadNote",
  teamEditThreadNote: "team.editThreadNote",
  teamReserveAcceptedNotes: "team.reserveAcceptedNotes",
  teamReleaseAcceptedNotes: "team.releaseAcceptedNotes",
  teamConsumeAcceptedNotes: "team.consumeAcceptedNotes",
  teamListThreadNotes: "team.listThreadNotes",
  teamUpsertProvider: "team.upsertProvider",
  teamDeleteProvider: "team.deleteProvider",
  teamListProviderUsage: "team.listProviderUsage",
  teamUpsertSkill: "team.upsertSkill",
  teamDeleteSkill: "team.deleteSkill",
  teamUpsertPreprompt: "team.upsertPreprompt",
  teamDeletePreprompt: "team.deletePreprompt",
  teamIssueLocalSyncToken: "team.issueLocalSyncToken",
  teamSyncLocalBinding: "team.syncLocalBinding",
  teamRemoveLocalBinding: "team.removeLocalBinding",
  teamNotifyLocalAssetsUpdated: "team.notifyLocalAssetsUpdated",
  teamUpdateMyMobileVisibility: "team.updateMyMobileVisibility",
  teamCreateMobilePairingLink: "team.createMobilePairingLink",
  teamListMyMobilePairingLinks: "team.listMyMobilePairingLinks",
  teamRevokeMyMobilePairingLink: "team.revokeMyMobilePairingLink",
  teamConnectMyGitHub: "team.connectMyGitHub",
  teamDisconnectMyGitHub: "team.disconnectMyGitHub",
  teamSetAutomationGitHub: "team.setAutomationGitHub",
  teamClearAutomationGitHub: "team.clearAutomationGitHub",
  teamSetGitHubAppConfig: "team.setGitHubAppConfig",
  teamClearGitHubAppConfig: "team.clearGitHubAppConfig",
  teamStartGitHubOAuth: "team.startGitHubOAuth",
  teamCompleteGitHubOAuth: "team.completeGitHubOAuth",
  teamStartGitHubDeviceFlow: "team.startGitHubDeviceFlow",
  teamPollGitHubDeviceFlow: "team.pollGitHubDeviceFlow",
  teamCancelGitHubDeviceFlow: "team.cancelGitHubDeviceFlow",
} as const;

export const TEAM_CLIENT_GUARDED_RPC_SCOPES = {
  [TEAM_WS_METHODS.teamInitialize]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamLeave]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamDelete]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamUpdateDisplayName]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamUpdateMyPseudo]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamUpdateMyMobileVisibility]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamCreateMobilePairingLink]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamRevokeMyMobilePairingLink]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamUpdateMemberRole]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamUpdateMemberStatus]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamCreateInvite]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamRevokeInvite]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamCreateView]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamUpdateView]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamDeleteView]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamSetThreadView]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamSetThreadLocked]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamFollowThread]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamUnfollowThread]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamAssignProject]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamUnassignProject]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamAttachEnvironment]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamUpdateEnvironment]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamDetachEnvironment]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamSyncLocalThread]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamCreateThreadNote]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamDeleteThreadNote]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamResolveThreadNote]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamEditThreadNote]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamReserveAcceptedNotes]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamReleaseAcceptedNotes]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamConsumeAcceptedNotes]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamUpsertProvider]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamDeleteProvider]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamUpsertSkill]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamDeleteSkill]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamUpsertPreprompt]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamDeletePreprompt]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamIssueLocalSyncToken]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamSyncLocalBinding]: AuthProvidersManageScope,
  [TEAM_WS_METHODS.teamRemoveLocalBinding]: AuthProvidersManageScope,
  [TEAM_WS_METHODS.teamNotifyLocalAssetsUpdated]: AuthProvidersManageScope,
  [TEAM_WS_METHODS.teamConnectMyGitHub]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamDisconnectMyGitHub]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamSetAutomationGitHub]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamClearAutomationGitHub]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamSetGitHubAppConfig]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamClearGitHubAppConfig]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamStartGitHubOAuth]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamCompleteGitHubOAuth]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamStartGitHubDeviceFlow]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamPollGitHubDeviceFlow]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamCancelGitHubDeviceFlow]: AuthOrchestrationOperateScope,
} as const;

export const TEAM_RPC_REQUIRED_SCOPES = {
  ...TEAM_CLIENT_GUARDED_RPC_SCOPES,
  [TEAM_WS_METHODS.teamGetState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamSubscribeState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListThreadAttributions]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListFollowedThreads]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListThreadNotes]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListMyMobilePairingLinks]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListProviderUsage]: AuthAccessWriteScope,
} as const;

const TeamRpcError = Schema.Union([TeamOperationError, EnvironmentAuthorizationError]);

const WsTeamGetStateRpc = Rpc.make(TEAM_WS_METHODS.teamGetState, {
  payload: Schema.Struct({}),
  success: TeamStateSnapshot,
  error: TeamRpcError,
});

const WsTeamSubscribeStateRpc = Rpc.make(TEAM_WS_METHODS.teamSubscribeState, {
  payload: Schema.Struct({}),
  success: TeamStateStreamEvent,
  error: TeamRpcError,
  stream: true,
});

const WsTeamInitializeRpc = Rpc.make(TEAM_WS_METHODS.teamInitialize, {
  payload: TeamInitializeInput,
  success: TeamInitializeResult,
  error: TeamRpcError,
});

const WsTeamLeaveRpc = Rpc.make(TEAM_WS_METHODS.teamLeave, {
  payload: Schema.Struct({}),
  success: TeamLeaveResult,
  error: TeamRpcError,
});

const WsTeamDeleteRpc = Rpc.make(TEAM_WS_METHODS.teamDelete, {
  payload: TeamDeleteInput,
  success: TeamDeleteResult,
  error: TeamRpcError,
});

const WsTeamUpdateDisplayNameRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateDisplayName, {
  payload: TeamUpdateDisplayNameInput,
  success: TeamWorkspace,
  error: TeamRpcError,
});

const WsTeamUpdateMyPseudoRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateMyPseudo, {
  payload: TeamUpdateMyPseudoInput,
  success: TeamMember,
  error: TeamRpcError,
});

const WsTeamUpdateMemberRoleRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateMemberRole, {
  payload: TeamUpdateMemberRoleInput,
  success: TeamMember,
  error: TeamRpcError,
});

const WsTeamUpdateMemberStatusRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateMemberStatus, {
  payload: TeamUpdateMemberStatusInput,
  success: TeamMember,
  error: TeamRpcError,
});

const WsTeamCreateInviteRpc = Rpc.make(TEAM_WS_METHODS.teamCreateInvite, {
  payload: TeamCreateInviteInput,
  success: TeamInviteCreatedResult,
  error: TeamRpcError,
});

const WsTeamRevokeInviteRpc = Rpc.make(TEAM_WS_METHODS.teamRevokeInvite, {
  payload: TeamRevokeInviteInput,
  success: TeamRevokeInviteResult,
  error: TeamRpcError,
});

const WsTeamCreateViewRpc = Rpc.make(TEAM_WS_METHODS.teamCreateView, {
  payload: TeamCreateViewInput,
  success: TeamView,
  error: TeamRpcError,
});

const WsTeamUpdateViewRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateView, {
  payload: TeamUpdateViewInput,
  success: TeamView,
  error: TeamRpcError,
});

const WsTeamDeleteViewRpc = Rpc.make(TEAM_WS_METHODS.teamDeleteView, {
  payload: TeamDeleteViewInput,
  success: TeamDeleteViewResult,
  error: TeamRpcError,
});

const WsTeamSetThreadViewRpc = Rpc.make(TEAM_WS_METHODS.teamSetThreadView, {
  payload: TeamSetThreadViewInput,
  success: TeamThreadAttribution,
  error: TeamRpcError,
});

const WsTeamSetThreadLockedRpc = Rpc.make(TEAM_WS_METHODS.teamSetThreadLocked, {
  payload: TeamSetThreadLockedInput,
  success: TeamThreadAttribution,
  error: TeamRpcError,
});

const WsTeamListThreadAttributionsRpc = Rpc.make(TEAM_WS_METHODS.teamListThreadAttributions, {
  payload: Schema.Struct({}),
  success: TeamListThreadAttributionsResult,
  error: TeamRpcError,
});

const WsTeamFollowThreadRpc = Rpc.make(TEAM_WS_METHODS.teamFollowThread, {
  payload: TeamThreadFollowInput,
  success: TeamThreadFollowResult,
  error: TeamRpcError,
});

const WsTeamUnfollowThreadRpc = Rpc.make(TEAM_WS_METHODS.teamUnfollowThread, {
  payload: TeamThreadFollowInput,
  success: TeamThreadFollowResult,
  error: TeamRpcError,
});

const WsTeamListFollowedThreadsRpc = Rpc.make(TEAM_WS_METHODS.teamListFollowedThreads, {
  payload: Schema.Struct({}),
  success: TeamListFollowedThreadsResult,
  error: TeamRpcError,
});

const WsTeamAssignProjectRpc = Rpc.make(TEAM_WS_METHODS.teamAssignProject, {
  payload: TeamAssignProjectInput,
  success: TeamProjectAssignment,
  error: TeamRpcError,
});

const WsTeamUnassignProjectRpc = Rpc.make(TEAM_WS_METHODS.teamUnassignProject, {
  payload: TeamUnassignProjectInput,
  success: TeamUnassignProjectResult,
  error: TeamRpcError,
});

const WsTeamAttachEnvironmentRpc = Rpc.make(TEAM_WS_METHODS.teamAttachEnvironment, {
  payload: TeamAttachEnvironmentInput,
  success: TeamEnvironment,
  error: TeamRpcError,
});

const WsTeamUpdateEnvironmentRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateEnvironment, {
  payload: TeamUpdateEnvironmentInput,
  success: TeamEnvironment,
  error: TeamRpcError,
});

const WsTeamDetachEnvironmentRpc = Rpc.make(TEAM_WS_METHODS.teamDetachEnvironment, {
  payload: TeamDetachEnvironmentInput,
  success: TeamDetachEnvironmentResult,
  error: TeamRpcError,
});

const WsTeamSyncLocalThreadRpc = Rpc.make(TEAM_WS_METHODS.teamSyncLocalThread, {
  payload: TeamSyncLocalThreadInput,
  success: TeamSyncLocalThreadResult,
  error: TeamRpcError,
});

const WsTeamCreateThreadNoteRpc = Rpc.make(TEAM_WS_METHODS.teamCreateThreadNote, {
  payload: TeamCreateThreadNoteInput,
  success: TeamThreadNote,
  error: TeamRpcError,
});

const WsTeamDeleteThreadNoteRpc = Rpc.make(TEAM_WS_METHODS.teamDeleteThreadNote, {
  payload: TeamDeleteThreadNoteInput,
  success: TeamDeleteThreadNoteResult,
  error: TeamRpcError,
});

const WsTeamResolveThreadNoteRpc = Rpc.make(TEAM_WS_METHODS.teamResolveThreadNote, {
  payload: TeamResolveThreadNoteInput,
  success: TeamThreadNote,
  error: TeamRpcError,
});

const WsTeamEditThreadNoteRpc = Rpc.make(TEAM_WS_METHODS.teamEditThreadNote, {
  payload: TeamEditThreadNoteInput,
  success: TeamThreadNote,
  error: TeamRpcError,
});

const WsTeamReserveAcceptedNotesRpc = Rpc.make(TEAM_WS_METHODS.teamReserveAcceptedNotes, {
  payload: TeamReserveAcceptedNotesInput,
  success: TeamReserveAcceptedNotesResult,
  error: TeamRpcError,
});

const WsTeamReleaseAcceptedNotesRpc = Rpc.make(TEAM_WS_METHODS.teamReleaseAcceptedNotes, {
  payload: TeamReleaseAcceptedNotesInput,
  success: TeamReleaseAcceptedNotesResult,
  error: TeamRpcError,
});

const WsTeamConsumeAcceptedNotesRpc = Rpc.make(TEAM_WS_METHODS.teamConsumeAcceptedNotes, {
  payload: TeamConsumeAcceptedNotesInput,
  success: TeamConsumeAcceptedNotesResult,
  error: TeamRpcError,
});

const WsTeamListThreadNotesRpc = Rpc.make(TEAM_WS_METHODS.teamListThreadNotes, {
  payload: TeamListThreadNotesInput,
  success: TeamListThreadNotesResult,
  error: TeamRpcError,
});

const WsTeamUpsertProviderRpc = Rpc.make(TEAM_WS_METHODS.teamUpsertProvider, {
  payload: TeamUpsertProviderInput,
  success: TeamProvider,
  error: TeamRpcError,
});

const WsTeamDeleteProviderRpc = Rpc.make(TEAM_WS_METHODS.teamDeleteProvider, {
  payload: TeamDeleteProviderInput,
  success: TeamDeleteProviderResult,
  error: TeamRpcError,
});

const WsTeamListProviderUsageRpc = Rpc.make(TEAM_WS_METHODS.teamListProviderUsage, {
  payload: Schema.Struct({}),
  success: TeamListProviderUsageResult,
  error: TeamRpcError,
});

const WsTeamUpsertSkillRpc = Rpc.make(TEAM_WS_METHODS.teamUpsertSkill, {
  payload: TeamUpsertSkillInput,
  success: TeamSkill,
  error: TeamRpcError,
});

const WsTeamDeleteSkillRpc = Rpc.make(TEAM_WS_METHODS.teamDeleteSkill, {
  payload: TeamDeleteSkillInput,
  success: TeamDeleteSkillResult,
  error: TeamRpcError,
});

const WsTeamUpsertPrepromptRpc = Rpc.make(TEAM_WS_METHODS.teamUpsertPreprompt, {
  payload: TeamUpsertPrepromptInput,
  success: TeamPreprompt,
  error: TeamRpcError,
});

const WsTeamDeletePrepromptRpc = Rpc.make(TEAM_WS_METHODS.teamDeletePreprompt, {
  payload: TeamDeletePrepromptInput,
  success: TeamDeletePrepromptResult,
  error: TeamRpcError,
});

const WsTeamIssueLocalSyncTokenRpc = Rpc.make(TEAM_WS_METHODS.teamIssueLocalSyncToken, {
  payload: Schema.Struct({}),
  success: TeamIssueLocalSyncTokenResult,
  error: TeamRpcError,
});

const WsTeamSyncLocalBindingRpc = Rpc.make(TEAM_WS_METHODS.teamSyncLocalBinding, {
  payload: TeamSyncLocalBindingInput,
  success: TeamSyncLocalBindingResult,
  error: TeamRpcError,
});

const WsTeamRemoveLocalBindingRpc = Rpc.make(TEAM_WS_METHODS.teamRemoveLocalBinding, {
  payload: TeamRemoveLocalBindingInput,
  success: TeamRemoveLocalBindingResult,
  error: TeamRpcError,
});

const WsTeamNotifyLocalAssetsUpdatedRpc = Rpc.make(TEAM_WS_METHODS.teamNotifyLocalAssetsUpdated, {
  payload: TeamNotifyLocalAssetsUpdatedInput,
  success: TeamNotifyLocalAssetsUpdatedResult,
  error: TeamRpcError,
});

const WsTeamUpdateMyMobileVisibilityRpc = Rpc.make(TEAM_WS_METHODS.teamUpdateMyMobileVisibility, {
  payload: TeamUpdateMyMobileVisibilityInput,
  success: TeamMember,
  error: TeamRpcError,
});

const WsTeamCreateMobilePairingLinkRpc = Rpc.make(TEAM_WS_METHODS.teamCreateMobilePairingLink, {
  payload: TeamCreateMobilePairingLinkInput,
  success: TeamCreateMobilePairingLinkResult,
  error: TeamRpcError,
});

const WsTeamListMyMobilePairingLinksRpc = Rpc.make(TEAM_WS_METHODS.teamListMyMobilePairingLinks, {
  payload: Schema.Struct({}),
  success: TeamListMyMobilePairingLinksResult,
  error: TeamRpcError,
});

const WsTeamRevokeMyMobilePairingLinkRpc = Rpc.make(TEAM_WS_METHODS.teamRevokeMyMobilePairingLink, {
  payload: TeamRevokeMobilePairingLinkInput,
  success: TeamRevokeMobilePairingLinkResult,
  error: TeamRpcError,
});

const WsTeamConnectMyGitHubRpc = Rpc.make(TEAM_WS_METHODS.teamConnectMyGitHub, {
  payload: TeamConnectMyGitHubInput,
  success: TeamGitHubIdentity,
  error: TeamRpcError,
});

const WsTeamDisconnectMyGitHubRpc = Rpc.make(TEAM_WS_METHODS.teamDisconnectMyGitHub, {
  payload: Schema.Struct({}),
  success: TeamDisconnectMyGitHubResult,
  error: TeamRpcError,
});

const WsTeamSetAutomationGitHubRpc = Rpc.make(TEAM_WS_METHODS.teamSetAutomationGitHub, {
  payload: TeamSetAutomationGitHubInput,
  success: TeamAutomationGitHubIdentity,
  error: TeamRpcError,
});

const WsTeamClearAutomationGitHubRpc = Rpc.make(TEAM_WS_METHODS.teamClearAutomationGitHub, {
  payload: Schema.Struct({}),
  success: TeamClearAutomationGitHubResult,
  error: TeamRpcError,
});

const WsTeamSetGitHubAppConfigRpc = Rpc.make(TEAM_WS_METHODS.teamSetGitHubAppConfig, {
  payload: TeamSetGitHubAppConfigInput,
  success: TeamGitHubAppConfig,
  error: TeamRpcError,
});

const WsTeamClearGitHubAppConfigRpc = Rpc.make(TEAM_WS_METHODS.teamClearGitHubAppConfig, {
  payload: Schema.Struct({}),
  success: TeamClearGitHubAppConfigResult,
  error: TeamRpcError,
});

const WsTeamStartGitHubOAuthRpc = Rpc.make(TEAM_WS_METHODS.teamStartGitHubOAuth, {
  payload: TeamStartGitHubOAuthInput,
  success: TeamStartGitHubOAuthResult,
  error: TeamRpcError,
});

const WsTeamCompleteGitHubOAuthRpc = Rpc.make(TEAM_WS_METHODS.teamCompleteGitHubOAuth, {
  payload: TeamCompleteGitHubOAuthInput,
  success: TeamGitHubIdentity,
  error: TeamRpcError,
});

const WsTeamStartGitHubDeviceFlowRpc = Rpc.make(TEAM_WS_METHODS.teamStartGitHubDeviceFlow, {
  payload: TeamStartGitHubDeviceFlowInput,
  success: TeamStartGitHubDeviceFlowResult,
  error: TeamRpcError,
});

const WsTeamPollGitHubDeviceFlowRpc = Rpc.make(TEAM_WS_METHODS.teamPollGitHubDeviceFlow, {
  payload: TeamPollGitHubDeviceFlowInput,
  success: TeamPollGitHubDeviceFlowResult,
  error: TeamRpcError,
});

const WsTeamCancelGitHubDeviceFlowRpc = Rpc.make(TEAM_WS_METHODS.teamCancelGitHubDeviceFlow, {
  payload: TeamCancelGitHubDeviceFlowInput,
  success: TeamCancelGitHubDeviceFlowResult,
  error: TeamRpcError,
});

export const TeamWsRpcGroup = RpcGroup.make(
  WsTeamGetStateRpc,
  WsTeamSubscribeStateRpc,
  WsTeamInitializeRpc,
  WsTeamLeaveRpc,
  WsTeamDeleteRpc,
  WsTeamUpdateDisplayNameRpc,
  WsTeamUpdateMyPseudoRpc,
  WsTeamUpdateMemberRoleRpc,
  WsTeamUpdateMemberStatusRpc,
  WsTeamCreateInviteRpc,
  WsTeamRevokeInviteRpc,
  WsTeamCreateViewRpc,
  WsTeamUpdateViewRpc,
  WsTeamDeleteViewRpc,
  WsTeamSetThreadViewRpc,
  WsTeamSetThreadLockedRpc,
  WsTeamListThreadAttributionsRpc,
  WsTeamFollowThreadRpc,
  WsTeamUnfollowThreadRpc,
  WsTeamListFollowedThreadsRpc,
  WsTeamAssignProjectRpc,
  WsTeamUnassignProjectRpc,
  WsTeamAttachEnvironmentRpc,
  WsTeamUpdateEnvironmentRpc,
  WsTeamDetachEnvironmentRpc,
  WsTeamSyncLocalThreadRpc,
  WsTeamCreateThreadNoteRpc,
  WsTeamDeleteThreadNoteRpc,
  WsTeamResolveThreadNoteRpc,
  WsTeamEditThreadNoteRpc,
  WsTeamReserveAcceptedNotesRpc,
  WsTeamReleaseAcceptedNotesRpc,
  WsTeamConsumeAcceptedNotesRpc,
  WsTeamListThreadNotesRpc,
  WsTeamUpsertProviderRpc,
  WsTeamDeleteProviderRpc,
  WsTeamListProviderUsageRpc,
  WsTeamUpsertSkillRpc,
  WsTeamDeleteSkillRpc,
  WsTeamUpsertPrepromptRpc,
  WsTeamDeletePrepromptRpc,
  WsTeamIssueLocalSyncTokenRpc,
  WsTeamSyncLocalBindingRpc,
  WsTeamRemoveLocalBindingRpc,
  WsTeamNotifyLocalAssetsUpdatedRpc,
  WsTeamUpdateMyMobileVisibilityRpc,
  WsTeamCreateMobilePairingLinkRpc,
  WsTeamListMyMobilePairingLinksRpc,
  WsTeamRevokeMyMobilePairingLinkRpc,
  WsTeamConnectMyGitHubRpc,
  WsTeamDisconnectMyGitHubRpc,
  WsTeamSetAutomationGitHubRpc,
  WsTeamClearAutomationGitHubRpc,
  WsTeamSetGitHubAppConfigRpc,
  WsTeamClearGitHubAppConfigRpc,
  WsTeamStartGitHubOAuthRpc,
  WsTeamCompleteGitHubOAuthRpc,
  WsTeamStartGitHubDeviceFlowRpc,
  WsTeamPollGitHubDeviceFlowRpc,
  WsTeamCancelGitHubDeviceFlowRpc,
);
