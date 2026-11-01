import type { ChildStatusCounts } from "@t3tools/client-runtime/state/child-status-counts";
import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import {
  ChildStatusCountIcons,
  childStatusCountsLabel,
  sameChildStatusCounts,
} from "../ChildStatusCounts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The children toggle's sidebar tree row; the parent's child rows name it as their parent. */
export function sidebarChildrenRowId(parentKey: string) {
  return `children:${parentKey}`;
}

// Rem per nesting level; matches the inset of the child rows below it.
const NEST_INSET_REM = 1;

/**
 * A compact line under a parent row: its child chats counted by state, and the
 * toggle that shows or hides them.
 */
type SidebarChildThreadsToggleProps = {
  rowId: string;
  parentKey: string;
  counts: ChildStatusCounts;
  expanded: boolean;
  /** The parent row's depth; the toggle sits one level in from it. */
  depth: number;
  inFolder: boolean;
  navigationParent: string | undefined;
  onToggle: (parentKey: string) => void;
};

// The sidebar rebuilds counts on each render, so compare them by value.
function togglePropsEqual(
  previous: SidebarChildThreadsToggleProps,
  next: SidebarChildThreadsToggleProps,
) {
  return (
    (Object.keys(next) as Array<keyof SidebarChildThreadsToggleProps>).every(
      (key) => key === "counts" || previous[key] === next[key],
    ) && sameChildStatusCounts(previous.counts, next.counts)
  );
}

export const SidebarChildThreadsToggle = memo(function SidebarChildThreadsToggle(
  props: SidebarChildThreadsToggleProps,
) {
  const label = childStatusCountsLabel(props.counts);
  return (
    <li className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              role="treeitem"
              tabIndex={-1}
              data-sidebar-row={props.rowId}
              data-sidebar-parent={props.navigationParent}
              data-testid="sidebar-child-threads-toggle"
              aria-expanded={props.expanded}
              aria-label={label}
              onClick={() => props.onToggle(props.parentKey)}
              style={{
                paddingInlineStart: `calc(${props.inFolder ? "2.25rem" : "0.625rem"} + ${
                  (props.depth + 1) * NEST_INSET_REM
                }rem)`,
              }}
              className="flex h-6 w-full cursor-pointer items-center gap-2 rounded-md pe-2.5 text-left text-xs tabular-nums text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", !props.expanded && "-rotate-90")}
          />
          <ChildStatusCountIcons counts={props.counts} />
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    </li>
  );
}, togglePropsEqual);
