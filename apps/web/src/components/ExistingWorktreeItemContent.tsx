import { FolderGitIcon } from "lucide-react";

import { resolveWorkspaceDisplayName } from "./BranchToolbar.logic";
import { MiddleTruncate } from "./ui/middle-truncate";

export function ExistingWorktreeItemContent({ path }: { path: string }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <FolderGitIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{resolveWorkspaceDisplayName(path) ?? path}</span>
        <span className="min-w-0 text-xs text-muted-foreground">
          <MiddleTruncate value={path} />
        </span>
      </span>
    </span>
  );
}
