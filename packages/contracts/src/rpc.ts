import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  DispatchResult,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  ClientOrchestrationCommand,
} from "./orchestration";
import {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import { ProjectSearchEntriesInput, ProjectSearchEntriesResult } from "./project";
import { OpenInEditorInput } from "./editor";
import {
  ServerBootstrapState,
  ServerConfig,
  ServerConfigUpdatedPayload,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";

export const ServerRpcError = Schema.Struct({
  message: Schema.String,
});
export type ServerRpcError = typeof ServerRpcError.Type;

const rpcOptions = {
  error: ServerRpcError,
} as const;

export const GetBootstrapRpc = Rpc.make("getBootstrap", {
  success: ServerBootstrapState,
  ...rpcOptions,
});

export const GetServerConfigRpc = Rpc.make("getServerConfig", {
  success: ServerConfig,
  ...rpcOptions,
});

export const UpsertKeybindingRpc = Rpc.make("upsertKeybinding", {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  ...rpcOptions,
});

export const SubscribeServerConfigRpc = Rpc.make("subscribeServerConfig", {
  success: ServerConfigUpdatedPayload,
  stream: true,
  ...rpcOptions,
});

export const GetSnapshotRpc = Rpc.make("getSnapshot", {
  success: OrchestrationRpcSchemas.getSnapshot.output,
  ...rpcOptions,
});

export const DispatchCommandRpc = Rpc.make("dispatchCommand", {
  payload: ClientOrchestrationCommand,
  success: DispatchResult,
  ...rpcOptions,
});

export const GetTurnDiffRpc = Rpc.make("getTurnDiff", {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationGetTurnDiffResult,
  ...rpcOptions,
});

export const GetFullThreadDiffRpc = Rpc.make("getFullThreadDiff", {
  payload: OrchestrationGetFullThreadDiffInput,
  success: OrchestrationGetFullThreadDiffResult,
  ...rpcOptions,
});

export const ReplayEventsRpc = Rpc.make("replayEvents", {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  ...rpcOptions,
});

export const SubscribeDomainEventsRpc = Rpc.make("subscribeDomainEvents", {
  success: OrchestrationEvent,
  stream: true,
  ...rpcOptions,
});

export const SearchEntriesRpc = Rpc.make("searchEntries", {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  ...rpcOptions,
});

export const OpenInEditorRpc = Rpc.make("openInEditor", {
  payload: OpenInEditorInput,
  ...rpcOptions,
});

export const GitStatusRpc = Rpc.make("gitStatus", {
  payload: GitStatusInput,
  success: GitStatusResult,
  ...rpcOptions,
});

export const GitPullRpc = Rpc.make("gitPull", {
  payload: GitPullInput,
  success: GitPullResult,
  ...rpcOptions,
});

export const GitRunStackedActionRpc = Rpc.make("gitRunStackedAction", {
  payload: GitRunStackedActionInput,
  success: GitRunStackedActionResult,
  ...rpcOptions,
});

export const GitListBranchesRpc = Rpc.make("gitListBranches", {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  ...rpcOptions,
});

export const GitCreateWorktreeRpc = Rpc.make("gitCreateWorktree", {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  ...rpcOptions,
});

export const GitRemoveWorktreeRpc = Rpc.make("gitRemoveWorktree", {
  payload: GitRemoveWorktreeInput,
  ...rpcOptions,
});

export const GitCreateBranchRpc = Rpc.make("gitCreateBranch", {
  payload: GitCreateBranchInput,
  ...rpcOptions,
});

export const GitCheckoutRpc = Rpc.make("gitCheckout", {
  payload: GitCheckoutInput,
  ...rpcOptions,
});

export const GitInitRpc = Rpc.make("gitInit", {
  payload: GitInitInput,
  ...rpcOptions,
});

export const GitResolvePullRequestRpc = Rpc.make("gitResolvePullRequest", {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  ...rpcOptions,
});

export const GitPreparePullRequestThreadRpc = Rpc.make("gitPreparePullRequestThread", {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  ...rpcOptions,
});

export const TerminalOpenRpc = Rpc.make("terminalOpen", {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  ...rpcOptions,
});

export const TerminalWriteRpc = Rpc.make("terminalWrite", {
  payload: TerminalWriteInput,
  ...rpcOptions,
});

export const TerminalResizeRpc = Rpc.make("terminalResize", {
  payload: TerminalResizeInput,
  ...rpcOptions,
});

export const TerminalClearRpc = Rpc.make("terminalClear", {
  payload: TerminalClearInput,
  ...rpcOptions,
});

export const TerminalRestartRpc = Rpc.make("terminalRestart", {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  ...rpcOptions,
});

export const TerminalCloseRpc = Rpc.make("terminalClose", {
  payload: TerminalCloseInput,
  ...rpcOptions,
});

export const SubscribeTerminalEventsRpc = Rpc.make("subscribeTerminalEvents", {
  success: TerminalEvent,
  stream: true,
  ...rpcOptions,
});

export const ServerRpcGroup = RpcGroup.make(
  GetBootstrapRpc,
  GetServerConfigRpc,
  UpsertKeybindingRpc,
  SubscribeServerConfigRpc,
  GetSnapshotRpc,
  DispatchCommandRpc,
  GetTurnDiffRpc,
  GetFullThreadDiffRpc,
  ReplayEventsRpc,
  SubscribeDomainEventsRpc,
  SearchEntriesRpc,
  OpenInEditorRpc,
  GitStatusRpc,
  GitPullRpc,
  GitRunStackedActionRpc,
  GitListBranchesRpc,
  GitCreateWorktreeRpc,
  GitRemoveWorktreeRpc,
  GitCreateBranchRpc,
  GitCheckoutRpc,
  GitInitRpc,
  GitResolvePullRequestRpc,
  GitPreparePullRequestThreadRpc,
  TerminalOpenRpc,
  TerminalWriteRpc,
  TerminalResizeRpc,
  TerminalClearRpc,
  TerminalRestartRpc,
  TerminalCloseRpc,
  SubscribeTerminalEventsRpc,
);
