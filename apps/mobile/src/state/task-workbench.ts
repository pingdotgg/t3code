import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentTask } from "@t3tools/client-runtime/state/tasks";
import { taskWorkbenchRef, workbenchRefFor } from "@t3tools/client-runtime/state/task-workbench";
import type { ScopedTaskRef, ScopedThreadRef } from "@t3tools/contracts";

interface MobileWorkbench {
  readonly ownerRef: ScopedThreadRef | null;
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null;
}

/** Conversation refs remain real thread IDs; only tool operations receive ownerRef. */
export function resolveMobileWorkbench(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly taskRef: ScopedTaskRef | null;
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "taskId" | "worktreePath"> | null;
  readonly task: Pick<EnvironmentTask, "environmentId" | "id"> | null;
  readonly project: Pick<EnvironmentProject, "workspaceRoot"> | null;
  readonly threadDetailWorktreePath?: string | null;
  readonly previous?: {
    readonly taskRef: ScopedTaskRef;
    readonly workbench: MobileWorkbench;
  } | null;
}): MobileWorkbench {
  const task =
    input.task?.environmentId === input.taskRef?.environmentId &&
    input.task?.id === input.taskRef?.taskId
      ? input.task
      : null;
  // Membership can arrive before its task/project shell. Never attach a
  // standalone terminal or expose the member checkout during that gap.
  if (input.taskRef !== null && (task === null || input.project === null)) {
    if (
      input.previous?.taskRef.environmentId === input.taskRef.environmentId &&
      input.previous.taskRef.taskId === input.taskRef.taskId
    ) {
      return input.previous.workbench;
    }
    return { ownerRef: null, workspaceRoot: null, worktreePath: null };
  }
  const ownerRef =
    input.threadRef !== null
      ? workbenchRefFor(input.threadRef, input.thread, task)
      : task !== null && input.taskRef !== null
        ? taskWorkbenchRef(input.taskRef)
        : null;
  const taskOwned = task !== null && (input.threadRef === null || input.thread?.taskId === task.id);
  const worktreePath = taskOwned
    ? null
    : (input.threadDetailWorktreePath ?? input.thread?.worktreePath ?? null);
  return { ownerRef, workspaceRoot: input.project?.workspaceRoot ?? null, worktreePath };
}
