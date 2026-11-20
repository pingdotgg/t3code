import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CheckCheckIcon, ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { memo, type DragEvent } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import {
  isSidebarThreadDone,
  resolveSidebarFolderStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ProjectFolderDropEdge } from "./useProjectFolderOrder";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
} as const;

// Trailing indicators make room for the header's hover actions, which sit over them.
const UNDER_ACTIONS_CLASS_NAME =
  "group-hover/project-folder:invisible group-has-[[data-sidebar-action-for]:focus]/project-folder:invisible pointer-coarse:invisible";

const FOLDER_DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count and a status dot only while it is closed, so a
 * closed folder still says when a hidden thread needs you. Its Done threads, open or
 * hidden, can be marked read from the header in one go.
 */
export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  threads: readonly EnvironmentThreadShell[];
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onMarkDoneRead: (doneThreads: readonly EnvironmentThreadShell[]) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
    doneThreads: readonly EnvironmentThreadShell[],
  ) => void;
  dragging: boolean;
  dropEdge: ProjectFolderDropEdge | null;
  onDragStart: (group: SidebarProjectSnapshot, event: DragEvent) => void;
  onDragOver: (group: SidebarProjectSnapshot, event: DragEvent) => void;
  onDragLeave: (group: SidebarProjectSnapshot, event: DragEvent) => void;
  onDrop: (group: SidebarProjectSnapshot, event: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const withVisit = (thread: EnvironmentThreadShell) => ({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      localLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    ),
  });
  const status = collapsed ? resolveSidebarFolderStatus(hiddenThreads.map(withVisit)) : null;
  const doneThreads = props.threads.filter((thread) => isSidebarThreadDone(withVisit(thread)));
  const markDoneReadLabel = `Mark ${doneThreads.length} done thread${doneThreads.length === 1 ? "" : "s"} in ${group.displayName} as read`;
  return (
    <li
      data-testid="sidebar-project-folder"
      draggable={!group.archived}
      onDragStart={(event) => props.onDragStart(group, event)}
      onDragOver={(event) => props.onDragOver(group, event)}
      onDragLeave={(event) => props.onDragLeave(group, event)}
      onDrop={(event) => props.onDrop(group, event)}
      onDragEnd={props.onDragEnd}
      className={cn(
        "group/project-folder relative mt-2 list-none first:mt-0",
        props.dragging && "opacity-50",
      )}
    >
      {props.dropEdge ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
            props.dropEdge === "before" ? "-top-1.25" : "-bottom-0.5",
          )}
        />
      ) : null}
      <button
        type="button"
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(group, { x: event.clientX, y: event.clientY }, doneThreads);
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ProjectFavicon project={group} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {status?.working ? (
          <Spinner
            aria-label="working"
            size="xs"
            tone="muted"
            className={cn("shrink-0", doneThreads.length > 0 && UNDER_ACTIONS_CLASS_NAME)}
          />
        ) : null}
        {status?.dot ? (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              FOLDER_DOT_CLASS_NAME[status.dot],
              doneThreads.length > 0 && UNDER_ACTIONS_CLASS_NAME,
            )}
          >
            <span className="sr-only">{FOLDER_DOT_LABEL[status.dot]}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums text-sidebar-muted-foreground",
              UNDER_ACTIONS_CLASS_NAME,
            )}
          >
            {hiddenThreads.length}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      {/* Sits over the count, which hides on hover or focus, and left of the chevron. */}
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        {doneThreads.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={markDoneReadLabel}
                  onClick={() => props.onMarkDoneRead(doneThreads)}
                />
              }
            >
              <CheckCheckIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>{markDoneReadLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
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
});
