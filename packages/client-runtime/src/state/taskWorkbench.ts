import {
  ThreadId,
  type EnvironmentId,
  type ScopedTaskRef,
  type ScopedThreadRef,
  type TaskId,
  type ProjectId,
  type ScopedProjectRef,
  type TerminalAttachInput,
} from "@t3tools/contracts";
import { taskWorkbenchId } from "@t3tools/shared/taskWorkbench";
import { scopeThreadRef } from "../environment/scoped.ts";

/** Resource identity only: never use this ref to load a conversation or start a provider. */
export function taskWorkbenchRef(ref: ScopedTaskRef): ScopedThreadRef {
  return scopeThreadRef(ref.environmentId, ThreadId.make(taskWorkbenchId(ref.taskId)));
}

export function workbenchRefFor(
  ref: ScopedThreadRef,
  thread:
    | { readonly taskId?: TaskId | null | undefined; readonly environmentId?: EnvironmentId }
    | null
    | undefined,
  task: { readonly id: TaskId; readonly environmentId: EnvironmentId } | null | undefined,
): ScopedThreadRef {
  return task &&
    task.environmentId === ref.environmentId &&
    thread?.taskId === task.id &&
    (thread.environmentId === undefined || thread.environmentId === ref.environmentId)
    ? taskWorkbenchRef({ environmentId: ref.environmentId, taskId: task.id })
    : ref;
}

export type WorkbenchResolution =
  | { readonly status: "unavailable"; readonly reason: "loading" | "missing" }
  | {
      readonly status: "ready";
      readonly ownerRef: ScopedThreadRef;
      readonly projectRef: ScopedProjectRef;
      readonly workspaceRoot: string;
      readonly cwd: string;
      readonly worktreePath: string | null;
    };

export interface WorkbenchInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly thread:
    | {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
        readonly taskId?: TaskId | null | undefined;
        readonly worktreePath: string | null;
      }
    | null
    | undefined;
  readonly taskRef?: ScopedTaskRef | null;
  readonly tasksSupported: boolean | undefined;
  readonly authoritative: boolean;
  readonly task:
    | {
        readonly environmentId: EnvironmentId;
        readonly id: TaskId;
        readonly primaryProjectId: ProjectId;
        readonly archivedAt?: string | null;
      }
    | null
    | undefined;
  readonly projects: readonly {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }[];
  readonly threadDetailWorktreePath?: string | null | undefined;
}

/** Resolves tool authority and its filesystem together; conversation operations keep threadRef. */
export function resolveWorkbench(input: WorkbenchInput): WorkbenchResolution {
  const unavailable = (): WorkbenchResolution => ({
    status: "unavailable",
    reason: input.authoritative ? "missing" : "loading",
  });
  const { threadRef, thread } = input;
  if (threadRef && thread && thread.environmentId !== threadRef.environmentId) return unavailable();
  const taskRef =
    input.taskRef ??
    (input.tasksSupported !== false && threadRef && thread?.taskId
      ? { environmentId: threadRef.environmentId, taskId: thread.taskId }
      : null);
  if (taskRef) {
    if (!input.authoritative) return unavailable();
    const task = input.task;
    if (
      !input.tasksSupported ||
      !task ||
      task.archivedAt ||
      task.environmentId !== taskRef.environmentId ||
      task.id !== taskRef.taskId ||
      (threadRef &&
        (threadRef.environmentId !== taskRef.environmentId || thread?.taskId !== taskRef.taskId))
    ) {
      return unavailable();
    }
    const project = input.projects.find(
      (candidate) =>
        candidate.environmentId === task.environmentId && candidate.id === task.primaryProjectId,
    );
    if (!project) return unavailable();
    return {
      status: "ready",
      ownerRef: taskWorkbenchRef(taskRef),
      projectRef: { environmentId: project.environmentId, projectId: project.id },
      workspaceRoot: project.workspaceRoot,
      cwd: project.workspaceRoot,
      worktreePath: null,
    };
  }
  if (!threadRef || !thread) return unavailable();
  const project = input.projects.find(
    (candidate) =>
      candidate.environmentId === threadRef.environmentId && candidate.id === thread.projectId,
  );
  if (!project) return unavailable();
  const worktreePath = input.threadDetailWorktreePath ?? thread.worktreePath;
  return {
    status: "ready",
    ownerRef: threadRef,
    projectRef: { environmentId: project.environmentId, projectId: project.id },
    workspaceRoot: project.workspaceRoot,
    cwd: worktreePath ?? project.workspaceRoot,
    worktreePath,
  };
}

/** Without current project authority, attach can observe a retained PTY but cannot create one. */
export function workbenchTerminalAttachInput(
  input: TerminalAttachInput,
  launchAllowed: boolean,
): TerminalAttachInput {
  if (launchAllowed) return input;
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    ...(input.cols !== undefined ? { cols: input.cols } : {}),
    ...(input.rows !== undefined ? { rows: input.rows } : {}),
  };
}
