import type { OrchestrationThreadShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
export function v2PullRequestThread(thread: OrchestrationThreadShell): OrchestrationV2ThreadShell {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.modelSelection.instanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: thread.pullRequests,
    linkedPullRequest: thread.linkedPullRequest,
    branchPullRequest: thread.branchPullRequest,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: thread.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: thread.latestUserMessageAt
      ? DateTime.makeUnsafe(thread.latestUserMessageAt)
      : null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: DateTime.makeUnsafe(thread.createdAt),
    updatedAt: DateTime.makeUnsafe(thread.updatedAt),
    archivedAt: thread.archivedAt ? DateTime.makeUnsafe(thread.archivedAt) : null,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt ? DateTime.makeUnsafe(thread.settledAt) : null,
    deletedAt: null,
  };
}
