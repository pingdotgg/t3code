import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuButton } from "../ui/sidebar";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you.
 */
export function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (group: SidebarProjectSnapshot, position: { x: number; y: number }) => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;
  return (
    <li
      data-testid="sidebar-project-folder"
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <SidebarMenuButton
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY });
        }}
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-label text-strong-foreground">
          {group.displayName}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{FOLDER_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-meta tabular-nums text-dim-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-dim-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </SidebarMenuButton>
      {/* Sits over the count, which hides on hover, and left of the chevron. */}
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-sidebar-action-for={rowId}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread in ${group.displayName}`}
                onClick={() => props.onNewThread(group)}
              />
            }
          >
            <SquarePenIcon aria-hidden />
          </TooltipTrigger>
          <TooltipPopup>New thread in {group.displayName}</TooltipPopup>
        </Tooltip>
      </span>
    </li>
  );
}
