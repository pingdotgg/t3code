import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

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
  const sessionLocation = input.terminalLocation ?? input.activeSessionLocation;

  // Keep cwd paired with its identity; null identifies the project checkout.
  if (sessionLocation !== null) {
    return { cwd: sessionLocation.cwd, worktreePath: sessionLocation.worktreePath };
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

export function useInitialTerminalLaunchLocation(input: {
  readonly targetKey: string | null;
  readonly pendingLaunch: PendingTerminalLaunch | null;
  readonly hasResolvedPendingLaunch: boolean;
  readonly isAuthenticated: boolean;
  readonly canRead: boolean;
  readonly canOperate: boolean;
  readonly hasLoadedSessions: boolean;
  readonly location: Parameters<typeof resolveTerminalOpenLocation>[0] | null;
}) {
  let candidate: TerminalLocationLike | null = null;
  if (
    input.location !== null &&
    input.hasResolvedPendingLaunch &&
    input.isAuthenticated &&
    (input.canRead || input.canOperate)
  ) {
    if (input.pendingLaunch !== null) {
      candidate = {
        cwd: input.pendingLaunch.cwd,
        worktreePath: input.pendingLaunch.worktreePath,
      };
    } else if (!input.canRead || input.hasLoadedSessions) {
      // Metadata must establish whether this target has a location before we retain a fallback.
      candidate = resolveTerminalOpenLocation(input.location);
    }
  }
  const [entry, setEntry] = useState(() => ({ key: input.targetKey, location: candidate }));
  useEffect(() => {
    if (entry.key === input.targetKey && (entry.location !== null || candidate === null)) {
      return;
    }
    setEntry({ key: input.targetKey, location: candidate });
  }, [candidate, entry.key, entry.location, input.targetKey]);
  return entry.key === input.targetKey ? entry.location : null;
}
