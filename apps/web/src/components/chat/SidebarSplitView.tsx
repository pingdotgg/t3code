import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { collectLeaves, type ChatPaneLeaf, type ChatPaneNode } from "~/chatPanes.logic";
import { useChatPanesStore } from "~/chatPanesStore";
import { cn } from "~/lib/utils";
import { useThreadStatus } from "~/state/entities";

/** Heading above one split group's threads in the sidebar list; the rows below
    it are the regular thread rows. Selecting it reopens the saved layout. */
export function SidebarSplitViewHeader({
  root,
  activeThreadKey,
  onOpenThread,
}: {
  root: ChatPaneNode;
  activeThreadKey: string | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const leaves = useMemo(() => collectLeaves(root), [root]);
  const focusedPaneId = useChatPanesStore((state) => state.focusedPaneId);
  const focused = leaves.find((leaf) => leaf.id === focusedPaneId) ?? leaves[0]!;
  const threadCount = leaves.filter((leaf) => !leaf.surface).length;
  const active =
    activeThreadKey !== null &&
    leaves.some((leaf) => scopedThreadKey(leaf.threadRef) === activeThreadKey);
  return (
    <>
      {leaves.map((leaf) => (
        <PaneLeafWatch key={leaf.id} leaf={leaf} />
      ))}
      <button
        type="button"
        onClick={() => onOpenThread(focused.threadRef)}
        aria-label={`Open split view with ${threadCount} thread${threadCount === 1 ? "" : "s"}`}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 px-2 text-left text-xs font-medium transition-colors hover:text-sidebar-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-primary" : "text-sidebar-muted-foreground/60",
        )}
      >
        <span aria-hidden className="flex h-3.5 w-5 shrink-0 gap-px">
          <PaneLayoutMap node={root} activeThreadKey={active ? activeThreadKey : null} />
        </span>
        <span className="shrink-0">Split view</span>
        <span
          aria-hidden
          className={cn("h-px min-w-2 flex-1", active ? "bg-primary/40" : "bg-sidebar-border/60")}
        />
      </button>
    </>
  );
}

function PaneLayoutMap({
  node,
  activeThreadKey,
}: {
  node: ChatPaneNode;
  activeThreadKey: string | null;
}) {
  if (node.kind === "leaf") {
    return (
      <span
        className={cn(
          "min-h-0 min-w-0 flex-1 rounded-[1.5px]",
          scopedThreadKey(node.threadRef) === activeThreadKey ? "bg-current" : "bg-current/35",
        )}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex min-h-0 min-w-0 flex-1 gap-px",
        node.direction === "vertical" && "flex-col",
      )}
    >
      <span className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0px` }}>
        <PaneLayoutMap node={node.first} activeThreadKey={activeThreadKey} />
      </span>
      <span className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0px` }}>
        <PaneLayoutMap node={node.second} activeThreadKey={activeThreadKey} />
      </span>
    </span>
  );
}

// A thread deleted while its pane is not mounted still leaves the layout.
function PaneLeafWatch({ leaf }: { leaf: ChatPaneLeaf }) {
  const status = useThreadStatus(leaf.threadRef);
  useEffect(() => {
    if (status === "deleted") useChatPanesStore.getState().closePane(leaf.id);
  }, [leaf.id, status]);
  return null;
}
