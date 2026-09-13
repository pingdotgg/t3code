import type { WorkbenchResolution } from "@t3tools/client-runtime/state/task-workbench";
import type { EnvironmentId, ThreadId, ScopedProjectRef } from "@t3tools/contracts";

interface TerminalLocationLike {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

interface PendingTerminalLaunchTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface PendingTerminalLaunch {
  readonly projectRef?: ScopedProjectRef;
  readonly projectCwd?: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env?: Record<string, string>;
  readonly initialInput?: string;
}

const pendingTerminalLaunches = new Map<string, PendingTerminalLaunch>();

function pendingTerminalLaunchKey(input: PendingTerminalLaunchTarget): string {
  return `${input.environmentId}:${input.threadId}:${input.terminalId}`;
}

export function stagePendingTerminalLaunch(input: {
  readonly target: PendingTerminalLaunchTarget;
  readonly launch: PendingTerminalLaunch;
}) {
  pendingTerminalLaunches.set(pendingTerminalLaunchKey(input.target), {
    projectRef: input.launch.projectRef,
    projectCwd: input.launch.projectCwd,
    cwd: input.launch.cwd,
    worktreePath: input.launch.worktreePath,
    env: input.launch.env ? { ...input.launch.env } : undefined,
    initialInput: input.launch.initialInput,
  });
}

export function takePendingTerminalLaunch(
  target: PendingTerminalLaunchTarget,
): PendingTerminalLaunch | null {
  const key = pendingTerminalLaunchKey(target);
  const launch = pendingTerminalLaunches.get(key) ?? null;
  if (launch) {
    pendingTerminalLaunches.delete(key);
  }

  return launch;
}

export function resolvePreferredThreadWorktreePath(input: {
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): string | null {
  return input.threadDetailWorktreePath ?? input.threadShellWorktreePath ?? null;
}

export function resolveTerminalOpenLocation(input: {
  readonly terminalLocation: TerminalLocationLike | null;
  readonly activeSessionLocation: TerminalLocationLike | null;
  readonly workspaceRoot: string;
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): {
  readonly cwd: string;
  readonly worktreePath: string | null;
} {
  // Existing PTYs retain their launch location, including an explicitly null
  // worktree, when the task's primary project or member selection changes.
  const existingLocation = input.terminalLocation ?? input.activeSessionLocation;
  if (existingLocation !== null) {
    return { cwd: existingLocation.cwd, worktreePath: existingLocation.worktreePath };
  }
  const preferredThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: input.threadShellWorktreePath,
    threadDetailWorktreePath: input.threadDetailWorktreePath,
  });

  return {
    cwd: preferredThreadWorktreePath ?? input.workspaceRoot,
    worktreePath: preferredThreadWorktreePath,
  };
}

/** Staged scripts cannot outlive the project/root they were selected for. */
export function pendingTerminalLaunchMatchesWorkbench(
  launch: PendingTerminalLaunch,
  workbench: WorkbenchResolution,
) {
  if (!launch.projectRef) return workbench.status === "ready";
  return (
    workbench.status === "ready" &&
    launch.projectRef.environmentId === workbench.projectRef.environmentId &&
    launch.projectRef.projectId === workbench.projectRef.projectId &&
    launch.projectCwd === workbench.workspaceRoot &&
    launch.cwd === workbench.cwd &&
    launch.worktreePath === workbench.worktreePath
  );
}
