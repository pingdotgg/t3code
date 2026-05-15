import { GitBranchIcon } from "lucide-react";
import { memo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface SidebarThreadBranchBadgeProps {
  readonly branch: string | null;
}

/**
 * Static branch label per chat row. Kept intentionally inert — no per-row
 * git-status subscription — so we don't add N TanStack queries to the
 * sidebar. Mismatch resolution happens in the chat header for the active
 * thread, which is the only place the user can act on it anyway.
 */
export const SidebarThreadBranchBadge = memo(function SidebarThreadBranchBadge({
  branch,
}: SidebarThreadBranchBadgeProps) {
  if (!branch) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={branch}
            data-testid="sidebar-thread-branch-badge"
            className="pointer-events-auto inline-flex h-4 max-w-[7rem] shrink-0 items-center gap-0.5 rounded-sm border border-border/50 bg-muted/40 px-1 font-mono text-[10px] leading-none tracking-tight text-muted-foreground/70"
          >
            <GitBranchIcon className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{branch}</span>
          </span>
        }
      />
      <TooltipPopup side="top">{branch}</TooltipPopup>
    </Tooltip>
  );
});
