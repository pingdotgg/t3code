// The client RPC schema table, binding each method to its input and output.
import * as Schema from "effect/Schema";

import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "./checkpointDiff.ts";

import {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadProjection,
} from "./orchestrationV2Events.ts";

import {
  OrchestrationV2Command,
} from "./orchestrationV2Commands.ts";

import {
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2CommandOutputFrame,
  OrchestrationV2DispatchCommandResult,
  OrchestrationV2ForceStopThreadInput,
  OrchestrationV2ForceStopThreadResult,
  OrchestrationV2GetNativeChildWorkInput,
  OrchestrationV2GetNativeChildWorkResult,
  OrchestrationV2GetOlderSettledThreadsInput,
  OrchestrationV2GetThreadFamilyInput,
  OrchestrationV2GetThreadProjectionInput,
  OrchestrationV2GetTurnItemInput,
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2GetWorkflowScriptInput,
  OrchestrationV2GetWorkflowScriptResult,
  OrchestrationV2GetWorktreeThreadIdsInput,
  OrchestrationV2OlderSettledThreadsPage,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2StopWorkflowInput,
  OrchestrationV2SubscribeCommandOutputInput,
  OrchestrationV2SubscribeShellInput,
  OrchestrationV2SubscribeThreadInput,
  OrchestrationV2ThreadFamily,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2WorktreeThreadIds,
} from "./orchestrationV2Rpc.ts";

export const OrchestrationV2RpcSchemas = {
  searchThread: {
    input: OrchestrationV2SearchThreadInput,
    output: OrchestrationV2SearchThreadResult,
  },
  dispatchCommand: {
    input: OrchestrationV2Command,
    output: OrchestrationV2DispatchCommandResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationV2ArchivedShellSnapshot,
  },
  getThreadFamily: {
    input: OrchestrationV2GetThreadFamilyInput,
    output: OrchestrationV2ThreadFamily,
  },
  getWorktreeThreadIds: {
    input: OrchestrationV2GetWorktreeThreadIdsInput,
    output: OrchestrationV2WorktreeThreadIds,
  },
  getOlderSettledThreads: {
    input: OrchestrationV2GetOlderSettledThreadsInput,
    output: OrchestrationV2OlderSettledThreadsPage,
  },
  getThreadProjection: {
    input: OrchestrationV2GetThreadProjectionInput,
    output: OrchestrationV2ThreadProjection,
  },
  stopWorkflow: {
    input: OrchestrationV2StopWorkflowInput,
    output: Schema.Void,
  },
  forceStopThread: {
    input: OrchestrationV2ForceStopThreadInput,
    output: OrchestrationV2ForceStopThreadResult,
  },
  getWorkflowScript: {
    input: OrchestrationV2GetWorkflowScriptInput,
    output: OrchestrationV2GetWorkflowScriptResult,
  },
  getNativeChildWork: {
    input: OrchestrationV2GetNativeChildWorkInput,
    output: OrchestrationV2GetNativeChildWorkResult,
  },
  getTurnItem: {
    input: OrchestrationV2GetTurnItemInput,
    output: OrchestrationV2GetTurnItemResult,
  },
  launchThread: {
    input: OrchestrationV2ThreadLaunchInput,
    output: OrchestrationV2ThreadLaunchResult,
  },
  subscribeShell: {
    input: OrchestrationV2SubscribeShellInput,
    output: OrchestrationV2ShellStreamItem,
  },
  subscribeThread: {
    input: OrchestrationV2SubscribeThreadInput,
    output: OrchestrationV2ThreadStreamItem,
  },
  subscribeCommandOutput: {
    input: OrchestrationV2SubscribeCommandOutputInput,
    output: OrchestrationV2CommandOutputFrame,
  },
} as const;
