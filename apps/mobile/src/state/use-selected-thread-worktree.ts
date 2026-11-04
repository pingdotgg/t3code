import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { useProject, useQuietThreadShell } from "./entities";
import { useEnvironmentThread } from "./threads";
import { useSelectedThreadWorktreePath, useThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: selectedThread?.worktreePath ?? null,
    threadDetailWorktreePath: detailWorktreePath,
  });

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  };
}

/**
 * Resolves a thread's cwd the way the selected thread's does, for a thread that is not the
 * current route's: the shell, or the loaded detail when the shell is missing, picks the project.
 */
export function useThreadCwd(ref: ScopedThreadRef | null): string | null {
  const shell = useQuietThreadShell(ref);
  const detailState = useEnvironmentThread(
    shell === null ? (ref?.environmentId ?? null) : null,
    shell === null ? (ref?.threadId ?? null) : null,
  );
  const detailThread = Option.getOrNull(detailState.data)?.thread ?? null;
  const detailWorktreePath = useThreadWorktreePath(ref);
  const projectId = shell?.projectId ?? detailThread?.projectId ?? null;
  const project = useProject(
    ref === null || projectId === null ? null : { environmentId: ref.environmentId, projectId },
  );
  return (
    resolvePreferredThreadWorktreePath({
      threadShellWorktreePath: shell?.worktreePath ?? null,
      threadDetailWorktreePath: detailWorktreePath,
    }) ??
    project?.workspaceRoot ??
    null
  );
}
