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

/** The one colour each child state has, wherever counts, rings, or summaries show it. */
export const CHILD_STATUS_COLORS: Readonly<Record<ChildStatusBucket, string>> = {
  needsInput: "var(--warning)",
  running: "var(--success)",
  waiting: "var(--muted-foreground)",
  failed: "var(--destructive)",
  done: "color-mix(in srgb, var(--muted-foreground) 45%, transparent)",
};

// Icons match the statuses on the child rows themselves.
const BUCKET_DISPLAY: Readonly<
  Record<ChildStatusBucket, { readonly label: string; readonly icon: typeof CircleDashedIcon }>
> = {
  needsInput: { label: "need input", icon: MessageCircleQuestionIcon },
  running: { label: "running", icon: CircleDashedIcon },
  waiting: { label: "waiting", icon: CircleDotDashedIcon },
  failed: { label: "failed", icon: CircleAlertIcon },
  done: { label: "done", icon: CircleCheckIcon },
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
    const { label, icon: Icon } = BUCKET_DISPLAY[bucket];
    return (
      <span
        key={bucket}
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center gap-1",
          bucket === "needsInput" && "font-medium",
        )}
        style={{ color: CHILD_STATUS_COLORS[bucket] }}
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
