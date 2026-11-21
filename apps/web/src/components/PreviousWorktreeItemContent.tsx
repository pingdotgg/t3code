import { T } from "gt-react";
import { HistoryIcon } from "lucide-react";

import { MiddleTruncate } from "./ui/middle-truncate";
import { definePluginComponent } from "~/plugins/features";

export const PreviousWorktreeItemContent = definePluginComponent(
  "component:components/PreviousWorktreeItemContent/PreviousWorktreeItemContent",
  PluginOriginalPreviousWorktreeItemContent,
);

function PluginOriginalPreviousWorktreeItemContent({ branch }: { branch: string | null }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <HistoryIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span>
          <T>Previous worktree</T>
        </span>
        {branch ? (
          <span className="min-w-0 text-xs text-muted-foreground">
            <MiddleTruncate value={branch} />
          </span>
        ) : null}
      </span>
    </span>
  );
}
