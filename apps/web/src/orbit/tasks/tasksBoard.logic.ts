import {
  ORBIT_TASK_LANES,
  orbitTaskLane,
  type OrbitTaskLane,
  type OrbitTasksErrorReason,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";

export function tasksBoardLanes(tasks: ReadonlyArray<OrbitTaskSummary>): ReadonlyArray<{
  readonly id: OrbitTaskLane;
  readonly label: string;
  readonly tasks: ReadonlyArray<OrbitTaskSummary>;
}> {
  return ORBIT_TASK_LANES.map((lane) => ({
    ...lane,
    tasks: tasks.filter((task) => orbitTaskLane(task.status) === lane.id),
  }));
}

/** The card's quiet line: subtask progress and the pull request, when there is one. */
export function taskCardDetail(task: OrbitTaskSummary): string {
  const { total, completed } = task.subtaskCounts;
  const parts = [total > 0 ? `${completed}/${total} subtasks` : "No subtasks"];
  if (task.pullRequest) parts.push(`PR #${task.pullRequest.number}`);
  return parts.join(" · ");
}

/** What the panel says when the list cannot be read. */
export function tasksErrorNotice(reason: OrbitTasksErrorReason): {
  readonly title: string;
  readonly kind: "access" | "unavailable";
} {
  switch (reason) {
    case "not-a-node":
      return { title: "This device is not an Orbit Node", kind: "access" };
    case "access-required":
      return { title: "No access to Orbit", kind: "access" };
    case "extension-disabled":
      return { title: "Tasks are turned off in Orbit", kind: "unavailable" };
    case "not-found":
      return { title: "Task not found", kind: "unavailable" };
    case "unreachable":
    case "invalid-response":
      return { title: "Tasks are unavailable", kind: "unavailable" };
  }
}
