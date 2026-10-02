import type {
  ModelSelection,
  OrchestrationV2ThreadShell,
  ProjectId,
  RuntimeMode,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The thread fields pull request tests set; timestamps are ISO strings. */
export interface PullRequestTestThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null;
  readonly latestUserMessageAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: OrchestrationV2ThreadShell["settledOverride"];
  readonly settledAt: string | null;
}

export function v2PullRequestThread(thread: PullRequestTestThread): OrchestrationV2ThreadShell {
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
