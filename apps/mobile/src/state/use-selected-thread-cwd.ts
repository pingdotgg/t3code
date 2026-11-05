import { useThreadSelection } from "./use-thread-selection";
import { useSelectedThreadWorktreePath } from "./use-thread-detail";

export function useSelectedThreadCwd() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const detailWorktreePath = useSelectedThreadWorktreePath();
  const selectedThreadWorktreePath = detailWorktreePath ?? selectedThread?.worktreePath ?? null;
  return {
    selectedThreadWorktreePath,
    selectedThreadCwd: selectedThreadWorktreePath ?? selectedThreadProject?.workspaceRoot ?? null,
  };
}
