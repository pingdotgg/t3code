import {
  resolveWorkbench,
  type WorkbenchInput,
  type WorkbenchResolution,
} from "@t3tools/client-runtime/state/task-workbench";
import type { ScopedTaskRef, ScopedThreadRef } from "@t3tools/contracts";

/** Retained mounts never grant permission to launch tools using stale metadata. */
export function resolveMobileWorkbench(
  input: Omit<WorkbenchInput, "projects" | "tasksSupported" | "authoritative"> & {
    readonly project: WorkbenchInput["projects"][number] | null;
    readonly tasksSupported?: boolean | undefined;
    readonly authoritative?: boolean;
    readonly previous?: {
      readonly taskRef: ScopedTaskRef;
      readonly workbench: MobileWorkbench;
    } | null;
  },
): MobileWorkbench {
  const resolution = resolveWorkbench({
    ...input,
    projects: input.project ? [input.project] : [],
    tasksSupported: "tasksSupported" in input ? input.tasksSupported : true,
    authoritative: input.authoritative ?? true,
  });
  const retained =
    resolution.status === "unavailable" &&
    resolution.reason === "loading" &&
    input.tasksSupported !== false &&
    !input.task?.archivedAt &&
    input.taskRef &&
    input.previous?.taskRef.environmentId === input.taskRef.environmentId &&
    input.previous.taskRef.taskId === input.taskRef.taskId
      ? input.previous.workbench
      : null;
  return {
    resolution,
    ownerRef: resolution.status === "ready" ? resolution.ownerRef : (retained?.ownerRef ?? null),
    displayCwd: resolution.status === "ready" ? resolution.cwd : (retained?.displayCwd ?? null),
    workspaceRoot:
      resolution.status === "ready" ? resolution.workspaceRoot : (retained?.workspaceRoot ?? null),
    worktreePath:
      resolution.status === "ready" ? resolution.worktreePath : (retained?.worktreePath ?? null),
  };
}
interface MobileWorkbench {
  readonly resolution: WorkbenchResolution;
  readonly ownerRef: ScopedThreadRef | null;
  readonly displayCwd: string | null;
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null;
}
