import {
  CHILD_STATUS_BUCKETS,
  type ChildStatusBucket,
  type ChildStatusCounts,
} from "@t3tools/client-runtime/state/child-status-counts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

// Icons match the statuses on the child rows themselves.
const BUCKET_DISPLAY: Readonly<
  Record<
    ChildStatusBucket,
    { readonly label: string; readonly icon: typeof CircleDashedIcon; readonly className: string }
  >
> = {
  needsInput: {
    label: "need input",
    icon: MessageCircleQuestionIcon,
    className: "font-medium text-indigo-600 dark:text-indigo-300",
  },
  running: { label: "running", icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { label: "waiting", icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  failed: { label: "failed", icon: CircleAlertIcon, className: "text-error-foreground" },
  done: { label: "done", icon: CircleCheckIcon, className: "text-muted-foreground" },
};

/** "3 child chats: 1 need input, 2 done", naming only the states that have children. */
export function childStatusCountsLabel(counts: ChildStatusCounts): string {
  const shown = CHILD_STATUS_BUCKETS.filter((bucket) => counts[bucket] > 0);
  const total = shown.reduce((sum, bucket) => sum + counts[bucket], 0);
  const summary = shown
    .map((bucket) => `${counts[bucket]} ${BUCKET_DISPLAY[bucket].label}`)
    .join(", ");
  return `${total} child ${total === 1 ? "chat" : "chats"}: ${summary}`;
}

/**
 * A collapsed parent's child chats counted by state, most actionable first.
 * Only states with children appear, and need input also says so in words,
 * since it waits on the user. Decorative: the toggle carries the label.
 */
export function ChildStatusCountIcons({ counts }: { readonly counts: ChildStatusCounts }) {
  return CHILD_STATUS_BUCKETS.filter((bucket) => counts[bucket] > 0).map((bucket) => {
    const { label, icon: Icon, className } = BUCKET_DISPLAY[bucket];
    return (
      <span
        key={bucket}
        aria-hidden
        className={cn("inline-flex shrink-0 items-center gap-1", className)}
      >
        <Icon className="size-3 shrink-0" />
        {counts[bucket]}
        {bucket === "needsInput" ? ` ${label}` : null}
      </span>
    );
  });
}

/** Compares counts by value, for memoized rows that receive rebuilt count objects. */
export function sameChildStatusCounts(left: ChildStatusCounts, right: ChildStatusCounts): boolean {
  return CHILD_STATUS_BUCKETS.every((bucket) => left[bucket] === right[bucket]);
}
