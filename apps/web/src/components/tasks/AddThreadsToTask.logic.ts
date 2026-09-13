import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import type { ScopedTaskRef, ThreadId } from "@t3tools/contracts";
import { sortThreads } from "../../lib/threadSort";

type CandidateThread = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "taskId"
  | "archivedAt"
  | "title"
  | "branch"
  | "updatedAt"
  | "createdAt"
  | "latestUserMessageAt"
>;

/** Search shell metadata only; picking members must not subscribe to conversation contents. */
export function taskThreadCandidates<T extends CandidateThread>(
  taskRef: ScopedTaskRef,
  threads: readonly T[],
  projects: readonly Pick<EnvironmentProject, "environmentId" | "id" | "title">[],
  tasks: readonly Pick<EnvironmentTask, "environmentId" | "id" | "name">[],
) {
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === taskRef.environmentId)
      .map((project) => [project.id, project.title]),
  );
  const taskNames = new Map(
    tasks
      .filter((task) => task.environmentId === taskRef.environmentId)
      .map((task) => [task.id, task.name]),
  );
  return sortThreads(
    threads.filter(
      (thread) =>
        thread.environmentId === taskRef.environmentId &&
        thread.archivedAt === null &&
        thread.taskId !== taskRef.taskId,
    ),
    "updated_at",
  ).map((thread) => {
    const projectName = projectNames.get(thread.projectId) ?? "Project unavailable";
    const taskName = thread.taskId ? (taskNames.get(thread.taskId) ?? "Another task") : null;
    return {
      thread,
      id: thread.id,
      title: thread.title,
      projectName,
      taskName,
      branch: thread.branch,
      searchText: [thread.title, projectName, taskName, thread.branch]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase(),
    };
  });
}

export function filterTaskThreadCandidates<T extends { searchText: string }>(
  items: readonly T[],
  query: string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => terms.every((term) => item.searchText.includes(term)));
}

/** Stop on failure so a retry contains only the failed and unattempted threads. */
export async function addSelectedThreadsToTask(
  threadIds: readonly ThreadId[],
  move: (id: ThreadId) => Promise<boolean>,
): Promise<ThreadId[]> {
  const pending = [...new Set(threadIds)];
  for (const [index, id] of pending.entries()) {
    try {
      if (!(await move(id))) return pending.slice(index);
    } catch {
      return pending.slice(index);
    }
  }
  return [];
}
