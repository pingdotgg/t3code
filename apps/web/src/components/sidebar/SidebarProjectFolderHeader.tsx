import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { groupIconFallbacks } from "@t3tools/client-runtime/state/project-grouping";
import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { SidebarMenuButton } from "../ui/sidebar";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: msg(", needs you", { $context: "project folder status, read after its name" }),
  failed: msg(", failed", { $context: "project folder status, read after its name" }),
  unread: msg(", done", { $context: "project folder status, read after its name" }),
  working: msg(", working", { $context: "project folder status, read after its name" }),
} as const;

/** The folder's sidebar tree row; its thread rows name it as their parent. */
export function sidebarFolderRowId(projectKey: string) {
  return `folder:${projectKey}`;
}

/**
 * A project folder in the boring sidebar. It reads like a shelf header: a trailing
 * count and chevron, with the count only while closed and a status dot whenever hidden
 * threads need you.
 */
export function SidebarProjectFolderHeader(props: {
  group: SidebarProjectSnapshot;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  onToggle: (group: SidebarProjectSnapshot) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarFolderRowId(group.projectKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const hasHiddenThreads = hiddenThreads.length > 0;
  const dot = hasHiddenThreads
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
  const hasCount = collapsed && hiddenThreads.length > 0;
  return (
    <li
      data-testid="sidebar-project-folder"
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <SidebarMenuButton
        size="project"
        type="button"
        data-sidebar-row={rowId}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(group)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            group,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
      >
        <ProjectFavicon
          project={group}
          fallbackProjects={groupIconFallbacks(group.memberProjects, group)}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate text-label text-sidebar-foreground/90">
          {group.displayName}
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span>
          </span>
        ) : null}
        {/* Widens to the new-thread button while it shows; empty, it also gives back its flex gap. */}
        <span
          className={cn(
            "flex min-w-0 shrink-0 justify-end group-hover/project-folder:min-w-4 group-has-[[data-sidebar-action-for]:focus]/project-folder:min-w-4 pointer-coarse:min-w-4",
            !hasCount &&
              "-ml-2.5 group-hover/project-folder:ml-0 group-has-[[data-sidebar-action-for]:focus]/project-folder:ml-0 pointer-coarse:ml-0",
          )}
        >
          {hasCount ? (
            <span className="text-meta tabular-nums text-dim-foreground group-hover/project-folder:invisible group-has-[[data-sidebar-action-for]:focus]/project-folder:invisible pointer-coarse:invisible">
              {hiddenThreads.length}
            </span>
          ) : null}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-dim-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </SidebarMenuButton>
      {/* Sits over the count, which hides on hover or focus, and left of the chevron. */}
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        <SharedTooltipTrigger
          render={
            <Button
              data-sidebar-action-for={rowId}
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("New thread in {project}", { project: group.displayName })}
              onClick={() => props.onNewThread(group)}
            />
          }
          label={
            <>
              <T>
                New thread in <Var>{group.displayName}</Var>
              </T>
            </>
          }
        >
          <SquarePenIcon aria-hidden />
        </SharedTooltipTrigger>
      </span>
    </li>
  );
}
