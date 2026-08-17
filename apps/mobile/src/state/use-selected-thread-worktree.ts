import { useMemo } from "react";

import { useSelectedThreadProjection } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadProjection();
  const detailWorktreePath = selectedThreadDetail?.projection.thread.worktreePath ?? null;

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: detailWorktreePath,
      }),
    [detailWorktreePath, selectedThread?.worktreePath],
  );

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  };
}
