import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";
import type { SidebarNeedsYouReason } from "../Sidebar.logic";

/**
 * Threads blocked on the user, above the folders. Rows carry only shell data and are not
 * sortable, so a thread listed here and in its folder costs no extra subscriptions.
 */
export function SidebarNeedsYouSection({
  entries,
  routeThreadKey,
  onOpen,
  onContextMenu,
}: {
  entries: ReadonlyArray<{
    readonly thread: Pick<SidebarThreadSummary, "environmentId" | "id" | "title">;
    readonly reason: SidebarNeedsYouReason;
  }>;
  routeThreadKey: string | null;
  onOpen: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  if (entries.length === 0) return null;
  const reasonLabel = (reason: SidebarNeedsYouReason) =>
    reason === "approval"
      ? gt("approve", { $context: "sidebar: a thread waits for the user to approve an action" })
      : reason === "input"
        ? gt("question", { $context: "sidebar: a thread waits for the user to answer a question" })
        : gt("guest", { $context: "sidebar: a guest's message waits for the owner's approval" });
  const heading = gt("Needs you · {count}", { count: entries.length });
  return (
    <li className="list-none">
      <div className="flex h-7 items-center ps-2.5 text-xs font-medium text-sidebar-muted-foreground">
        {heading}
      </div>
      <ul aria-label={heading} className="flex flex-col gap-px">
        {entries.map(({ thread, reason }) => {
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);
          const threadKey = scopedThreadKey(threadRef);
          const label = reasonLabel(reason);
          return (
            <li key={threadKey} className="list-none">
              <button
                type="button"
                data-sidebar-row={`needs-you:${threadKey}`}
                aria-label={gt("{title}, {reason}", { title: thread.title, reason: label })}
                aria-current={routeThreadKey === threadKey ? "page" : undefined}
                onClick={() => onOpen(threadRef)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onContextMenu(
                    threadRef,
                    { x: event.clientX, y: event.clientY },
                    contextMenuSourceOf(event),
                  );
                }}
                className={cn(
                  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  routeThreadKey === threadKey
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-row-hover",
                )}
              >
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
                <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
                  {thread.title}
                </span>
                <span aria-hidden className="shrink-0 text-xs text-warning-foreground">
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
