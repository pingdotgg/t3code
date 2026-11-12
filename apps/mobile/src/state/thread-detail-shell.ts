import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";

function latestUserMessageAt(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell["latestUserMessageAt"] {
  for (let index = projection.messages.length - 1; index >= 0; index -= 1) {
    const message = projection.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

/** The shell row of a thread the shell left out, from its loaded detail. */
export function threadDetailToShell(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentThreadShell {
  const thread = projection.thread;
  const latestRun = deriveLatestThreadRun(projection);
  const runtime = deriveThreadRuntime(projection);
  const pendingRequest =
    projection.runtimeRequests.find((request) => request.status === "pending") ?? null;
  return presentThreadShell(environmentId, {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    linkedPullRequest: thread.linkedPullRequest ?? null,
    pullRequests: thread.pullRequests,
    branchPullRequest: thread.branchPullRequest ?? null,
    activeProviderThreadId: thread.activeProviderThreadId,
    lineage: thread.lineage,
    linkOrigin: thread.linkOrigin,
    delegatedFrom: thread.delegatedFrom,
    forkedFrom: thread.forkedFrom,
    createdBy: thread.createdBy,
    creationSource: thread.creationSource,
    latestRunId: latestRun?.runId ?? null,
    activeRunId: runtime?.activeRunId ?? null,
    status: runtime?.status ?? "idle",
    pendingRuntimeRequest:
      pendingRequest === null
        ? null
        : { id: pendingRequest.id, kind: pendingRequest.kind, createdAt: pendingRequest.createdAt },
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessageAt(projection),
    hasActionableProposedPlan: false,
    itemCount: projection.turnItems.length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt,
    activeOrderKey: thread.activeOrderKey,
    autoSettleDisabledAt: thread.autoSettleDisabledAt,
    pinnedAt: thread.pinnedAt,
    pinOrderKey: thread.pinOrderKey,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    deletedAt: thread.deletedAt,
  });
}
