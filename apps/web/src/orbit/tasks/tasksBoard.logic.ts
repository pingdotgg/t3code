import {
  ORBIT_TASK_LANES,
  orbitTaskLane,
  type OrbitTaskLane,
  type OrbitTasksErrorReason,
  type OrbitTaskSummary,
} from "@t3tools/client-runtime/orbit-gateway";

/** Search matches the title, the project, the task number (with or without "#") and the machine. */
export function matchesTaskQuery(task: OrbitTaskSummary, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/, "");
  if (needle.length === 0) return true;
  return [task.title, task.project.name, String(task.id), task.workspace?.node?.name ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/** The lanes the user keeps on, with the tasks that match the search and the lane's full count. */
export function tasksBoardLanes(
  tasks: ReadonlyArray<OrbitTaskSummary>,
  options: { readonly query?: string; readonly hiddenLanes?: ReadonlyArray<OrbitTaskLane> } = {},
): ReadonlyArray<{
  readonly id: OrbitTaskLane;
  readonly label: string;
  readonly tasks: ReadonlyArray<OrbitTaskSummary>;
  readonly total: number;
}> {
  const hidden = options.hiddenLanes ?? [];
  return ORBIT_TASK_LANES.filter((lane) => !hidden.includes(lane.id)).map((lane) => {
    const inLane = tasks.filter((task) => orbitTaskLane(task.status) === lane.id);
    return {
      ...lane,
      tasks: inLane.filter((task) => matchesTaskQuery(task, options.query ?? "")),
      total: inLane.length,
    };
  });
}

/** The card's quiet line: subtask progress and the machine the task runs on. */
export function taskCardDetail(task: OrbitTaskSummary): string {
  const { total, completed } = task.subtaskCounts;
  const parts = [total > 0 ? `${completed}/${total} subtasks` : "No subtasks"];
  const machine = task.workspace?.node?.name;
  if (machine) parts.push(machine);
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
