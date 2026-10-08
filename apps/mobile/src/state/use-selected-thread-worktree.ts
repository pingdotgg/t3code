import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useMemo } from "react";

import { useSelectedThreadWorktreePath } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();

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
    /** Git surfaces work from the checkout root, like the web diff panel. */
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
    /** Where the agent works: a subdirectory project stays in that directory of its worktree. */
    selectedThreadWorkingDirectory: selectedThreadProject
      ? projectScriptCwd({
          project: {
            cwd: selectedThreadProject.workspaceRoot,
            repositoryRoot: selectedThreadProject.repositoryIdentity?.rootPath,
          },
          worktreePath: selectedThreadWorktreePath,
        })
      : null,
  };
}
