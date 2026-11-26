import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ContextMenuSource } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderStatus, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Spinner } from "../ui/spinner";
import type { ThreadFolderSummary } from "./threadFolders.logic";

/** Marks a header a boring-sidebar thread drag can drop on; empty on the project folder itself. */
export const THREAD_FOLDER_DROP_ATTRIBUTE = "data-thread-folder-drop";
export const THREAD_FOLDER_PROJECT_ATTRIBUTE = "data-thread-folder-project";

export function threadFolderDropAttributes(projectKey: string, folderId: string | null) {
  return {
    [THREAD_FOLDER_DROP_ATTRIBUTE]: folderId ?? "",
    [THREAD_FOLDER_PROJECT_ATTRIBUTE]: projectKey,
  };
}

const DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
} as const;

const DOT_LABEL = {
  attention: msg(", needs you", { $context: "project folder status, read after its name" }),
  failed: msg(", failed", { $context: "project folder status, read after its name" }),
  unread: msg(", done", { $context: "project folder status, read after its name" }),
} as const;

export function sidebarThreadFolderRowId(projectKey: string, folderId: string) {
  return `thread-folder:${projectKey}:${folderId}`;
}

/**
 * A folder inside a boring-sidebar project folder. Like the project folder, a closed
 * one shows its count and the most urgent status of the threads it hides.
 */
export const SidebarThreadFolderHeader = memo(function SidebarThreadFolderHeader(props: {
  group: SidebarProjectSnapshot;
  folder: ThreadFolderSummary;
  navigationParent: string;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  isDropTarget: boolean;
  onToggle: (folderId: string) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    folder: ThreadFolderSummary,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { group, folder, collapsed, hiddenThreads } = props;
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const status = collapsed
    ? resolveSidebarFolderStatus(
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
  const Icon = collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <li data-testid="sidebar-thread-folder" className="list-none">
      <button
        type="button"
        data-sidebar-row={sidebarThreadFolderRowId(group.projectKey, folder.id)}
        data-sidebar-parent={props.navigationParent}
        {...threadFolderDropAttributes(group.projectKey, folder.id)}
        aria-expanded={!collapsed}
        onClick={() => props.onToggle(folder.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            group,
            folder,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) ps-9 pe-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isDropTarget && "bg-primary/5 ring-1 ring-inset ring-primary/40",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
          {folder.name}
        </span>
        {status?.working ? (
          <Spinner aria-label={gt("working")} size="xs" tone="muted" className="shrink-0" />
        ) : null}
        {status?.dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS_NAME[status.dot])}>
            <span className="sr-only">{m(DOT_LABEL[status.dot])}</span>
          </span>
        ) : null}
        {collapsed && hiddenThreads.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
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
    </li>
  );
});
