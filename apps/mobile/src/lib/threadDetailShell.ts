import type { EnvironmentId, OrchestrationThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { derivePendingApprovals, derivePendingUserInputs } from "./threadActivity";
import { hasActionableProposedPlan } from "./proposedPlans";

function latestUserMessageAt(thread: OrchestrationThread): OrchestrationThread["updatedAt"] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

/**
 * Builds a thread shell from the detail record when the shell snapshot has no
 * entry for the thread yet. The pending/actionable flags are derived from the
 * same activity and plan data the server uses, so status pills do not go dark
 * while the shell snapshot is unavailable.
 */
export function threadDetailToShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    executorModelSelection: thread.executorModelSelection,
    executorMaxSubAgents: thread.executorMaxSubAgents,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    parentThreadId: thread.parentThreadId,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    session: thread.session,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
    hasPendingUserInput: derivePendingUserInputs(thread.activities).length > 0,
    hasActionableProposedPlan: hasActionableProposedPlan({
      proposedPlans: thread.proposedPlans,
      latestTurnId: thread.latestTurn?.turnId ?? null,
    }),
  };
}
