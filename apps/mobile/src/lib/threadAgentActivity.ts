import {
  foldSubagentActivitiesWithBatchCounts,
  isTerminalSubagentStatus,
  type FoldSubagentActivitiesOptions,
  type FoldedSubagentActivitiesWithBatchCounts,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";

interface AgentSpawnRow {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId: TurnId | null;
  readonly label: string;
  readonly agentLive: boolean;
  readonly tone: "info";
  readonly activityKind: OrchestrationThreadActivity["kind"];
}

interface SubagentActivityFold {
  readonly ordered: ReadonlyArray<OrchestrationThreadActivity>;
  readonly fold: FoldedSubagentActivitiesWithBatchCounts;
}

export interface DerivedAgentSpawnRows {
  readonly orderedActivities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly agentTaskIds: ReadonlySet<string>;
  readonly rowsByAnchorActivityId: ReadonlyMap<string, AgentSpawnRow>;
}

const AGENT_TASK_ACTIVITY_KINDS: ReadonlySet<OrchestrationThreadActivity["kind"]> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
]);

function activityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") return 0;
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) return 1;
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) return 2;
  return 1;
}

const activityOrder = Order.combineAll<OrchestrationThreadActivity>([
  Order.mapInput(Order.Number, (activity) => activity.sequence ?? Number.MAX_SAFE_INTEGER),
  Order.mapInput(Order.String, (activity) => activity.createdAt),
  Order.mapInput(Order.Number, (activity) => activityLifecycleRank(activity.kind)),
  Order.mapInput(Order.String, (activity) => activity.id),
]);

const foldedSubagentsByActivityList = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  {
    readonly ordered: ReadonlyArray<OrchestrationThreadActivity>;
    readonly folds: Map<boolean | undefined, FoldedSubagentActivitiesWithBatchCounts>;
  }
>();

function getSubagentActivityFold(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: FoldSubagentActivitiesOptions,
): SubagentActivityFold {
  let cached = foldedSubagentsByActivityList.get(activities);
  if (!cached) {
    cached = { ordered: Arr.sort(activities, activityOrder), folds: new Map() };
    foldedSubagentsByActivityList.set(activities, cached);
  }
  const sessionLive = options?.sessionLive;
  let fold = cached.folds.get(sessionLive);
  if (!fold) {
    fold = foldSubagentActivitiesWithBatchCounts(cached.ordered, options);
    cached.folds.set(sessionLive, fold);
  }
  return { ordered: cached.ordered, fold };
}

export function memoizedFoldSubagentActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: FoldSubagentActivitiesOptions,
): FoldedSubagentActivitiesWithBatchCounts {
  return getSubagentActivityFold(activities, options).fold;
}

export function agentTaskIdFromActivity(activity: OrchestrationThreadActivity): string | null {
  if (!AGENT_TASK_ACTIVITY_KINDS.has(activity.kind)) return null;
  if (
    !Predicate.isObjectOrArray(activity.payload) ||
    !Predicate.hasProperty(activity.payload, "taskId") ||
    !Predicate.isString(activity.payload.taskId)
  ) {
    return null;
  }
  const taskId = activity.payload.taskId.trim();
  return taskId.length > 0 ? taskId : null;
}

export function deriveAgentSpawnRows(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: FoldSubagentActivitiesOptions,
): DerivedAgentSpawnRows {
  const { ordered, fold } = getSubagentActivityFold(activities, options);
  const agentsById = new Map(fold.agents.map((agent) => [agent.id, agent]));
  const batches = new Map<
    string,
    { anchor: OrchestrationThreadActivity; anchorIsCoordinator: boolean }
  >();

  for (const activity of ordered) {
    const taskId = agentTaskIdFromActivity(activity);
    if (!taskId) continue;
    const groupKey = fold.batchKeyByActivityId.get(activity.id);
    if (!groupKey) continue;
    const isWorkflowCoordinator = groupKey === `wf:${taskId}`;
    const batch = batches.get(groupKey);
    if (!batch) {
      batches.set(groupKey, { anchor: activity, anchorIsCoordinator: isWorkflowCoordinator });
    } else if (isWorkflowCoordinator && !batch.anchorIsCoordinator) {
      batch.anchor = activity;
      batch.anchorIsCoordinator = true;
    }
  }

  const rowsByAnchorActivityId = new Map<string, AgentSpawnRow>();
  for (const [groupKey, batch] of batches) {
    const counts = fold.batchCounts.get(groupKey);
    if (!counts) continue;
    const {
      totalCount: agentCount,
      workingCount,
      failedCount,
      stoppedCount,
      idleCount,
      completedCount,
    } = counts;
    const coordinator = groupKey.startsWith("wf:") ? agentsById.get(groupKey.slice(3)) : undefined;
    const live =
      coordinator?.kind === "workflow"
        ? !isTerminalSubagentStatus(coordinator.status)
        : workingCount > 0;
    const lead =
      agentCount === 0 && coordinator?.kind === "workflow"
        ? `${live ? "Kicked off" : "Ran"} workflow`
        : `${live ? "Kicked off" : "Ran"} ${agentCount} subagent${agentCount === 1 ? "" : "s"}`;
    const terminalOutcomes = [
      failedCount > 0 ? `${failedCount} failed` : null,
      stoppedCount > 0 ? `${stoppedCount} stopped` : null,
      idleCount > 0 ? `${idleCount} idle` : null,
    ].filter((outcome): outcome is string => outcome !== null);
    const coordinatorOutcome =
      coordinator?.status === "failed"
        ? "failed"
        : coordinator?.status === "cancelled" || coordinator?.status === "interrupted"
          ? "stopped"
          : null;
    const status = live
      ? workingCount > 0
        ? `${workingCount} working`
        : "working"
      : terminalOutcomes.join(" · ") ||
        coordinatorOutcome ||
        (completedCount === agentCount && (agentCount > 0 || coordinator?.status === "completed")
          ? "completed"
          : "stopped");
    rowsByAnchorActivityId.set(batch.anchor.id, {
      id: `agent-spawn:${groupKey}`,
      createdAt: batch.anchor.createdAt,
      turnId: batch.anchor.turnId,
      label: `${lead} · ${status}`,
      agentLive: live,
      tone: "info",
      activityKind: batch.anchor.kind,
    });
  }

  return {
    orderedActivities: ordered,
    agentTaskIds: fold.agentTaskIds,
    rowsByAnchorActivityId,
  };
}

/**
 * Sorts activities into lifecycle order. `derivePendingApprovals` and
 * `derivePendingUserInputs` both expect this ordering; sorting once and
 * passing the result to both avoids re-sorting the full activity history
 * per derivation.
 */
export function sortThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  return Arr.sort(activities, activityOrder);
}
