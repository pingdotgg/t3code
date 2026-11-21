import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { DelegatedTaskGroup } from "@t3tools/client-runtime/state/threads";
import { ChevronDownIcon, WorkflowIcon } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useUiStateStore } from "../../uiStateStore";
import {
  animateSidebarLayoutChanges,
  resolveSidebarFolderDot,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function sidebarDelegatedGroupRowId(groupKey: string) {
  return `delegated:${groupKey}`;
}

/**
 * The row for a parent thread on a machine this client does not list, standing in its
 * most relevant task's place. It opens like a folder onto every task the parent delegated here.
 */
export function SidebarDelegatedTaskGroup(props: {
  group: DelegatedTaskGroup;
  tasks: readonly EnvironmentThreadShell[];
  contextDrag: boolean;
  navigationParent: string | undefined;
  /** The open thread is one of the tasks. */
  containsRouteThread: boolean;
  revealRef?: ((row: HTMLElement, threadKey: string) => (() => void) | undefined) | undefined;
  renderTask: (task: EnvironmentThreadShell, groupRowId: string) => ReactNode;
}) {
  const gt = useGT();
  const m = useMessages();
  const { group, tasks } = props;
  const [expanded, setExpanded] = useState(false);
  const rowId = sidebarDelegatedGroupRowId(group.key);
  // Holds its representative's slot in the sortable list; the group itself does not drag.
  const { setNodeRef, transform, transition } = useSortable({
    id: group.representativeKey,
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const dot = resolveSidebarFolderDot(
    tasks.map((task) => ({
      ...task,
      lastVisitedAt: resolveThreadLastVisitedAt(
        task.lastVisitedAt,
        localLastVisitedAtById[scopedThreadKey(scopeThreadRef(task.environmentId, task.id))],
      ),
    })),
  );
  const machineLabel =
    group.environmentLabel ??
    gt("Other machine", { $context: "a machine this app is not connected to" });
  const isActive = props.containsRouteThread && !expanded;
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: props.contextDrag ? undefined : CSS.Translate.toString(transform),
        transition,
      }}
      data-testid="sidebar-delegated-task-group"
      className="list-none"
    >
      <button
        type="button"
        ref={(row) => (row === null ? undefined : props.revealRef?.(row, group.representativeKey))}
        data-sidebar-row={rowId}
        data-sidebar-parent={props.navigationParent}
        aria-expanded={expanded}
        aria-current={isActive ? "page" : undefined}
        aria-label={gt(
          "{title}, delegated from {machine}, {count, plural, one {{count} task} other {{count} tasks}}",
          { title: group.title, machine: machineLabel, count: tasks.length },
        )}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isActive
            ? "bg-sidebar-row-active light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "hover:bg-sidebar-row-hover",
        )}
      >
        <WorkflowIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">{group.title}</span>
          <span className="truncate text-xs text-sidebar-muted-foreground">{machineLabel}</span>
        </span>
        {dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span>
          </span>
        ) : null}
        <span aria-hidden className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
          {tasks.length}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      </button>
      {expanded ? (
        <ul role="presentation" className="flex flex-col gap-px pt-px">
          {tasks.map((task) => props.renderTask(task, rowId))}
        </ul>
      ) : null}
    </li>
  );
}
