import {
  CHILD_STATUS_BUCKETS,
  type ChildStatusBucket,
  type ChildStatusCounts,
} from "@t3tools/client-runtime/state/child-status-counts";
import { Fragment } from "react";
import { Text as InlineText } from "react-native";

import { cn } from "../lib/cn";
import { AppText as Text } from "./ui/AppText";

/**
 * The one colour each child state has, wherever counts, rings, or summaries
 * show it. Matches web's CHILD_STATUS_COLORS: warning, success, muted,
 * destructive, and a dimmed muted for done.
 */
export const CHILD_STATUS_CLASSES: Readonly<
  Record<ChildStatusBucket, { readonly ring: string; readonly text: string }>
> = {
  needsInput: { ring: "border-warning-foreground", text: "text-warning-foreground" },
  running: { ring: "border-adaptive-emerald-600-400", text: "text-adaptive-emerald-600-400" },
  waiting: { ring: "border-foreground-tertiary", text: "text-foreground-muted" },
  failed: { ring: "border-danger-foreground", text: "text-danger-foreground" },
  done: { ring: "border-foreground-tertiary/45", text: "text-foreground-tertiary" },
};

const BUCKET_LABELS: Readonly<Record<ChildStatusBucket, string>> = {
  needsInput: "needs input",
  running: "running",
  waiting: "waiting",
  failed: "failed",
  done: "done",
};

/** "1 needs input · 1 running · 6 waiting": the states that have children, most actionable first. */
export function childStatusSummaryText(counts: ChildStatusCounts): string {
  return CHILD_STATUS_BUCKETS.filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `${counts[bucket]} ${BUCKET_LABELS[bucket]}`)
    .join(" · ");
}

/** "3 child chats: 1 needs input · 2 done", for the toggle's accessibility label. */
export function childStatusAccessibilityLabel(counts: ChildStatusCounts): string {
  const total = CHILD_STATUS_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0);
  return `${total} child ${total === 1 ? "chat" : "chats"}: ${childStatusSummaryText(counts)}`;
}

/** The summary line; needs input leads in the warning colour. One line, truncating at the end. */
export function ChildStatusSummaryText(props: {
  readonly counts: ChildStatusCounts;
  readonly className?: string;
}) {
  const parts = CHILD_STATUS_BUCKETS.filter((bucket) => props.counts[bucket] > 0);
  return (
    <Text
      className={cn("text-xs tabular-nums text-foreground-muted", props.className)}
      numberOfLines={1}
      ellipsizeMode="tail"
    >
      {parts.map((bucket, index) => (
        <Fragment key={bucket}>
          {index > 0 ? " · " : null}
          {/* Plain inline Text inherits the line's style; AppText would reset it. */}
          <InlineText
            className={
              bucket === "needsInput"
                ? cn("font-t3-medium", CHILD_STATUS_CLASSES.needsInput.text)
                : undefined
            }
          >
            {props.counts[bucket]} {BUCKET_LABELS[bucket]}
          </InlineText>
        </Fragment>
      ))}
    </Text>
  );
}

/** Compares counts by value, for memoized rows that receive rebuilt count objects. */
export function sameChildStatusCounts(left: ChildStatusCounts, right: ChildStatusCounts): boolean {
  return CHILD_STATUS_BUCKETS.every((bucket) => left[bucket] === right[bucket]);
}
