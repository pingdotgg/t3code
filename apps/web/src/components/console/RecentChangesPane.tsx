import { cn } from "~/lib/utils";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import type { WorkspaceArtifact } from "../../workspaceArtifacts";
import { ScrollArea } from "../ui/scroll-area";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

function statusToneClass(status: WorkspaceArtifact["status"]) {
  switch (status) {
    case "Created":
      return "text-emerald-400";
    case "Removed":
      return "text-rose-400";
    case "Moved":
    case "Moved and updated":
      return "text-amber-400";
    default:
      return "text-blue-400";
  }
}

interface RecentChangesPaneProps {
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  recentArtifacts: ReadonlyArray<WorkspaceArtifact>;
  onSelectFile: (path: string) => void;
}

/**
 * Body content of the Recent Changes card. Surfaces files the agent has
 * recently created/updated in this workspace so the user can jump straight
 * to them without hunting through the tree.
 */
export function RecentChangesPane({
  workspaceRoot,
  resolvedTheme,
  recentArtifacts,
  onSelectFile,
}: RecentChangesPaneProps) {
  if (recentArtifacts.length === 0) {
    return (
      <div className="px-3 py-3 text-sm leading-6 text-muted-foreground/72">
        No recent changes yet. Files the agent creates or updates in this workspace will appear
        here.
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 max-h-[40vh]">
      <div className="space-y-1 p-2">
        {recentArtifacts.slice(0, 12).map((artifact) => (
          <button
            key={`recent:${artifact.id}`}
            type="button"
            onClick={() => onSelectFile(artifact.path)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground/84 transition-colors hover:bg-background/70"
          >
            <VscodeEntryIcon
              pathValue={artifact.path}
              kind="file"
              theme={resolvedTheme}
              className="size-3.5 shrink-0 text-muted-foreground/65"
            />
            <span className="min-w-0 flex-1 truncate">
              {formatWorkspaceRelativePath(artifact.path, workspaceRoot)}
            </span>
            <span className={cn("text-[10px] font-medium", statusToneClass(artifact.status))}>
              {artifact.status}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
