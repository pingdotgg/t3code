import {
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

const EPOCH = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

/**
 * A thread in the middle of a turn on the `codex` instance: the shape the
 * access gate reads for a thread caller, and for the threads a caller targets.
 */
export const liveThreadShell = (
  id: ThreadId,
  modes: {
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly activeRunId?: RunId | null;
  } = {},
): OrchestrationV2ThreadShell => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id,
    projectId: ProjectId.make("project:mcp-test"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: modes.runtimeMode ?? "full-access",
    interactionMode: modes.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: modes.activeRunId === undefined ? RunId.make("run:mcp-test") : modes.activeRunId,
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

/**
 * `ThreadManagementService` that answers only the access gate's lookups,
 * every thread a live full-access one. For tests of a tool rather than of who
 * may call it.
 */
export const liveThreadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
});

/**
 * The thread of `shell` with no runs, messages or other records: what a
 * caller looks like once its turn has ended.
 */
export const idleThreadProjection = (
  shell: OrchestrationV2ThreadShell,
): OrchestrationV2ThreadProjection => {
  const {
    status: _status,
    activeRunId: _activeRunId,
    latestRunId: _latestRunId,
    pendingRuntimeRequest: _pendingRuntimeRequest,
    latestVisibleMessage: _latestVisibleMessage,
    latestUserMessageAt: _latestUserMessageAt,
    hasActionableProposedPlan: _hasActionableProposedPlan,
    itemCount: _itemCount,
    visibleItemCount: _visibleItemCount,
    lastVisitedAt,
    ...thread
  } = shell;
  return {
    thread: { ...thread, lastVisitedAt: lastVisitedAt ?? null },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: shell.updatedAt,
  };
};
