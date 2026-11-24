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
  TeamInitializeInput,
  TeamInitializeResult,
  TeamInviteCreatedResult,
  TeamListThreadAttributionsResult,
  TeamMember,
  TeamOperationError,
  TeamRevokeInviteInput,
  TeamRevokeInviteResult,
  TeamStateSnapshot,
  TeamStateStreamEvent,
  TeamUpdateMyPseudoInput,
} from "./schemas.ts";

export const TEAM_WS_METHODS = {
  teamGetState: "team.getState",
  teamSubscribeState: "team.subscribeState",
  teamInitialize: "team.initialize",
  teamUpdateMyPseudo: "team.updateMyPseudo",
  teamCreateInvite: "team.createInvite",
  teamRevokeInvite: "team.revokeInvite",
  teamListThreadAttributions: "team.listThreadAttributions",
} as const;

export const TEAM_CLIENT_GUARDED_RPC_SCOPES = {
  [TEAM_WS_METHODS.teamInitialize]: AuthAccessWriteScope,
  [TEAM_WS_METHODS.teamUpdateMyPseudo]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamCreateInvite]: AuthOrchestrationOperateScope,
  [TEAM_WS_METHODS.teamRevokeInvite]: AuthOrchestrationOperateScope,
} as const;

export const TEAM_RPC_REQUIRED_SCOPES = {
  ...TEAM_CLIENT_GUARDED_RPC_SCOPES,
  [TEAM_WS_METHODS.teamGetState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamSubscribeState]: AuthOrchestrationReadScope,
  [TEAM_WS_METHODS.teamListThreadAttributions]: AuthOrchestrationReadScope,
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

const WsTeamListThreadAttributionsRpc = Rpc.make(TEAM_WS_METHODS.teamListThreadAttributions, {
  payload: Schema.Struct({}),
  success: TeamListThreadAttributionsResult,
  error: TeamRpcError,
});

export const TeamWsRpcGroup = RpcGroup.make(
  WsTeamGetStateRpc,
  WsTeamSubscribeStateRpc,
  WsTeamInitializeRpc,
  WsTeamUpdateMyPseudoRpc,
  WsTeamCreateInviteRpc,
  WsTeamRevokeInviteRpc,
  WsTeamListThreadAttributionsRpc,
);
