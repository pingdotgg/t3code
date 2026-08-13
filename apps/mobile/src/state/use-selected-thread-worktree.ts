import { useMemo } from "react";

import { projectHasWorkspace } from "@t3tools/client-runtime/state/project-kind";
import { useSelectedThreadDetail } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const hasWorkspace = projectHasWorkspace(selectedThreadProject);

  const selectedThreadWorktreePath = useMemo(
    () =>
      hasWorkspace
        ? resolvePreferredThreadWorktreePath({
            threadShellWorktreePath: selectedThread?.worktreePath ?? null,
            threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
          })
        : null,
    [hasWorkspace, selectedThread?.worktreePath, selectedThreadDetail?.worktreePath],
  );

  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: hasWorkspace
      ? (selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null)
      : null,
  };
}
