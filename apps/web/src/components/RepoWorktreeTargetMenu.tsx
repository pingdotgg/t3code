import type { ThreadRepoWorktree } from "@t3tools/contracts";
import { ChevronDownIcon, FolderGit2Icon } from "lucide-react";

import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/menu";

const WORKSPACE_VALUE = "__thread_workspace__";

/** Picks the repository a thread's Changes and Git actions work in. */
export function RepoWorktreeTargetMenu(props: {
  readonly repoWorktrees: ReadonlyArray<ThreadRepoWorktree>;
  readonly selected: ThreadRepoWorktree | null;
  readonly workspaceLabel: string;
  readonly onSelect: (worktreePath: string | null) => void;
}) {
  if (props.repoWorktrees.length === 0) return null;
  const label =
    props.selected === null
      ? props.workspaceLabel
      : `${props.selected.repository} · ${props.selected.branch}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="xs" variant="ghost-muted" />}
        className="min-w-0 max-w-56"
        aria-label={`Repository: ${label}`}
      >
        <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={props.selected?.worktreePath ?? WORKSPACE_VALUE}
          onValueChange={(value) => props.onSelect(value === WORKSPACE_VALUE ? null : value)}
        >
          <DropdownMenuRadioItem value={WORKSPACE_VALUE} closeOnClick>
            {props.workspaceLabel}
          </DropdownMenuRadioItem>
          {props.repoWorktrees.map((entry) => (
            <DropdownMenuRadioItem key={entry.worktreePath} value={entry.worktreePath} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{entry.repository}</span>
                <span className="min-w-0 truncate text-muted-foreground">{entry.branch}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
