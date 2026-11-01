import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarChildBucket, SidebarChildCounts } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The children toggle's sidebar tree row; the parent's child rows name it as their parent. */
export function sidebarChildrenRowId(parentKey: string) {
  return `children:${parentKey}`;
}

// Most actionable first. Icons match the statuses on the child rows themselves.
const BUCKETS: ReadonlyArray<{
  readonly bucket: SidebarChildBucket;
  readonly label: string;
  readonly icon: typeof CircleDashedIcon;
  readonly className: string;
}> = [
  {
    bucket: "needsInput",
    label: "need input",
    icon: MessageCircleQuestionIcon,
    className: "font-medium text-indigo-600 dark:text-indigo-300",
  },
  {
    bucket: "running",
    label: "running",
    icon: CircleDashedIcon,
    className: "text-info-foreground",
  },
  {
    bucket: "waiting",
    label: "waiting",
    icon: CircleDotDashedIcon,
    className: "text-muted-foreground",
  },
  { bucket: "failed", label: "failed", icon: CircleAlertIcon, className: "text-error-foreground" },
  { bucket: "done", label: "done", icon: CircleCheckIcon, className: "text-muted-foreground" },
];

// Rem per nesting level; matches the inset of the child rows below it.
const NEST_INSET_REM = 1;

/**
 * A compact line under a parent row: its child chats counted by state, and the
 * toggle that shows or hides them. Only states with children appear, and
 * questions or approvals also say so in words, since they wait on the user.
 */
type SidebarChildThreadsToggleProps = {
  rowId: string;
  parentKey: string;
  counts: SidebarChildCounts;
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
    ) && BUCKETS.every(({ bucket }) => previous.counts[bucket] === next.counts[bucket])
  );
}

export const SidebarChildThreadsToggle = memo(function SidebarChildThreadsToggle(
  props: SidebarChildThreadsToggleProps,
) {
  const { counts } = props;
  const shown = BUCKETS.filter(({ bucket }) => counts[bucket] > 0);
  const total = shown.reduce((sum, { bucket }) => sum + counts[bucket], 0);
  const summary = shown.map(({ bucket, label }) => `${counts[bucket]} ${label}`).join(", ");
  const label = `${total} child ${total === 1 ? "chat" : "chats"}: ${summary}`;
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
          {shown.map(({ bucket, label: bucketLabel, icon: Icon, className }) => (
            <span
              key={bucket}
              aria-hidden
              className={cn("inline-flex shrink-0 items-center gap-1", className)}
            >
              <Icon className="size-3 shrink-0" />
              {counts[bucket]}
              {bucket === "needsInput" ? ` ${bucketLabel}` : null}
            </span>
          ))}
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    </li>
  );
}, togglePropsEqual);
