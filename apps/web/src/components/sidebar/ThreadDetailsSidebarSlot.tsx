import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { registerThreadDetailsSidebarSlot } from "../chat/threadDetailsSidebarSlot";

/** Holds the open thread's details card under its sidebar row; the chat view renders into it. */
export function ThreadDetailsSidebarSlot({
  threadRef,
  hidden,
}: {
  threadRef: ScopedThreadRef;
  /** Set while rows are dragged: the sorting strategy measures only sortable rows. */
  hidden: boolean;
}) {
  const open = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const threadKey = scopedThreadKey(threadRef);
  return (
    <li
      role="presentation"
      hidden={hidden}
      className="mb-1 ms-3 border-s border-sidebar-border ps-1"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", !open)}
        className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-(--control-radius) px-2 text-left text-xs text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Thread details
      </button>
      <div
        ref={(element) =>
          element ? registerThreadDetailsSidebarSlot(threadKey, element) : undefined
        }
      />
    </li>
  );
}
