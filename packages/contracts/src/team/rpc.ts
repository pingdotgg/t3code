import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "../auth.ts";
import {
  TeamAssignProjectInput,
  TeamAttachEnvironmentInput,
  TeamConsumeAcceptedNotesInput,
  TeamConsumeAcceptedNotesResult,
  TeamCreateInviteInput,
  TeamCreateThreadNoteInput,
  TeamCreateViewInput,
  TeamDeleteThreadNoteInput,
  TeamDeleteThreadNoteResult,
  TeamDeleteViewInput,
  TeamDeleteViewResult,
  TeamDetachEnvironmentInput,
  TeamDetachEnvironmentResult,
  TeamEditThreadNoteInput,
  TeamEnvironment,
  TeamInitializeInput,
  TeamInitializeResult,
  TeamInviteCreatedResult,
  TeamListFollowedThreadsResult,
  TeamListThreadAttributionsResult,
  TeamListThreadNotesInput,
  TeamListThreadNotesResult,
  TeamMember,
  TeamOperationError,
  TeamProjectAssignment,
  TeamReleaseAcceptedNotesInput,
  TeamReleaseAcceptedNotesResult,
  TeamReserveAcceptedNotesInput,
  TeamReserveAcceptedNotesResult,
  TeamResolveThreadNoteInput,
  TeamRevokeInviteInput,
  TeamRevokeInviteResult,
  TeamSetThreadLockedInput,
  TeamSetThreadViewInput,
  TeamStateSnapshot,
  TeamStateStreamEvent,
  TeamSyncLocalThreadInput,
  TeamSyncLocalThreadResult,
  TeamThreadAttribution,
  TeamThreadFollowInput,
  TeamThreadFollowResult,
  TeamThreadNote,
  TeamUnassignProjectInput,
  TeamUnassignProjectResult,
  TeamUpdateEnvironmentInput,
  TeamUpdateMemberRoleInput,
  TeamUpdateMemberStatusInput,
  TeamUpdateMyPseudoInput,
  TeamUpdateViewInput,
  TeamView,
} from "./schemas.ts";

export const TEAM_WS_METHODS = {
  teamGetState: "team.getState",
  teamSubscribeState: "team.subscribeState",
  teamInitialize: "team.initialize",
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
} as const;

export const TEAM_CLIENT_GUARDED_RPC_SCOPES = {
  [TEAM_WS_METHODS.teamInitialize]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamUpdateMyPseudo]: AuthOrchestrationReadScope,
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
} as const;

export const TEAM_RPC_REQUIRED_SCOPES = {
  ...TEAM_CLIENT_GUARDED_RPC_SCOPES,
  [TEAM_WS_METHODS.teamGetState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamSubscribeState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListThreadAttributions]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListFollowedThreads]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListThreadNotes]: AuthOrchestrationReadScope,
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

export const TeamWsRpcGroup = RpcGroup.make(
  WsTeamGetStateRpc,
  WsTeamSubscribeStateRpc,
  WsTeamInitializeRpc,
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
);
