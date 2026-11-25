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
  TeamCreateInviteInput,
  TeamCreateViewInput,
  TeamDeleteViewInput,
  TeamDeleteViewResult,
  TeamInitializeInput,
  TeamInitializeResult,
  TeamInviteCreatedResult,
  TeamListFollowedThreadsResult,
  TeamListThreadAttributionsResult,
  TeamMember,
  TeamOperationError,
  TeamRevokeInviteInput,
  TeamRevokeInviteResult,
  TeamSetThreadLockedInput,
  TeamSetThreadViewInput,
  TeamStateSnapshot,
  TeamStateStreamEvent,
  TeamThreadAttribution,
  TeamThreadFollowInput,
  TeamThreadFollowResult,
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
} as const;

export const TEAM_RPC_REQUIRED_SCOPES = {
  ...TEAM_CLIENT_GUARDED_RPC_SCOPES,
  [TEAM_WS_METHODS.teamGetState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamSubscribeState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListThreadAttributions]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListFollowedThreads]: AuthOrchestrationReadScope,
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
);
