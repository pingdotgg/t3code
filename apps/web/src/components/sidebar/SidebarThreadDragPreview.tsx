import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { GitBranchIcon, MessageSquareIcon } from "lucide-react";
import { memo } from "react";

import { ProjectFavicon } from "../ProjectFavicon";

export interface SidebarThreadDragPreviewProps {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly projectTitle: string | null;
  readonly projectCwd: string | null;
  readonly projectFaviconPath: string | null;
}

export const SidebarThreadDragPreview = memo(function SidebarThreadDragPreview(
  props: SidebarThreadDragPreviewProps,
) {
  const favicon = (
    <ProjectFavicon
      environmentId={props.thread.environmentId}
      cwd={props.projectCwd ?? ""}
      faviconPath={props.projectFaviconPath}
      className="size-4 shrink-0"
      fallbackIcon={MessageSquareIcon}
    />
  );

  if (props.variant === "slim") {
    return (
      <div
        aria-hidden
        className="pointer-events-none flex h-9 items-center gap-2.5 overflow-hidden rounded-md bg-sidebar-row-active px-2.5 text-sidebar-foreground shadow-lg ring-1 ring-sidebar-border/70"
      >
        {favicon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {props.thread.title}
        </span>
      </div>
    );
  }

  return (
    <div aria-hidden className="pointer-events-none h-[5.125rem] py-0.5">
      <div className="h-[4.875rem] overflow-hidden rounded-md bg-sidebar-row-active text-sidebar-foreground shadow-lg ring-1 ring-sidebar-border/70">
        <div className="h-full px-[var(--sidebar-row-content-inset)] py-[var(--sidebar-content-inset)]">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {favicon}
            {props.projectTitle ? (
              <span className="min-w-0 flex-1 truncate text-secondary-label text-xs font-medium">
                {props.projectTitle}
              </span>
            ) : (
              <span className="flex-1" />
            )}
          </div>
          <div className="mt-1 flex min-w-0">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
              {props.thread.title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
            {props.thread.branch ? (
              <>
                <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate whitespace-nowrap">
                  {props.thread.branch}
                </span>
              </>
            ) : (
              <span className="flex-1" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
