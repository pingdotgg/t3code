import { FolderGitIcon } from "lucide-react";
import { memo } from "react";
import { vcsWorktreeLabel } from "@t3tools/client-runtime/state/vcs";
import type { VcsWorktree } from "@t3tools/contracts";

import { MenuItem, MenuSub, MenuSubPopup, MenuSubTrigger } from "./ui/menu";

interface ExistingWorktreesMenuSubProps {
  worktrees: ReadonlyArray<VcsWorktree>;
  disabled: boolean;
  onSelect: (worktree: VcsWorktree) => void;
}

export const ExistingWorktreesMenuSub = memo(function ExistingWorktreesMenuSub({
  worktrees,
  disabled,
  onSelect,
}: ExistingWorktreesMenuSubProps) {
  if (worktrees.length === 0) return null;

  return (
    <MenuSub>
      <MenuSubTrigger className="cursor-default" disabled={disabled}>
        <FolderGitIcon className="size-3" />
        Worktrees
      </MenuSubTrigger>
      <MenuSubPopup className="max-w-80 min-w-48">
        {worktrees.map((worktree) => (
          <MenuItem key={worktree.path} onClick={() => onSelect(worktree)}>
            <FolderGitIcon className="size-3" />
            <span className="min-w-0 truncate">{vcsWorktreeLabel(worktree)}</span>
          </MenuItem>
        ))}
      </MenuSubPopup>
    </MenuSub>
  );
});
