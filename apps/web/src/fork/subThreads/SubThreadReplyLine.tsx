import type { ScopedThreadRef } from "@t3tools/contracts";
import { ReplyIcon } from "lucide-react";
import { use } from "react";

import { type TimelineRow, TimelineRowCtx } from "../../components/chat/timelineRowContext";
import { RelativeTime } from "../../components/RelativeTime";
import { cn } from "../../lib/utils";
import { useThreadDisplayMode } from "../displayMode/useThreadDisplayMode";
import {
  openSubThread,
  type SubThreadSummary,
  SubThreadViewContext,
  unreadReplies,
  useSubThreadStates,
  useSubThreadSummaries,
} from "./subThreadsState";

/** The sub-thread that the row `rowId` starts, in the main list of a thread with sub-threads. */
function useRowSubThread(rowId: string) {
  const { threadRef } = use(TimelineRowCtx);
  const inMainList =
    useThreadDisplayMode(threadRef).subThreads && use(SubThreadViewContext) === null;
  const summary = useSubThreadSummaries(inMainList ? threadRef : null).get(rowId);
  return threadRef === null || summary === undefined ? null : { threadRef, summary };
}

/**
 * Directly under a first message that has replies, above the row's time and actions, so the line
 * reads as part of that message: how many replies, how many are unread, when the latest came and
 * what they are about. Any other row gets nothing.
 */
export function SubThreadReplyLine(props: {
  readonly rowId: string;
  readonly fromUser: boolean;
  /**
   * When the row draws nothing under the line: always, or only in a wide lane, where a user's row
   * that is grouped with the next one moves its actions beside the bubble. The line then keeps
   * its own distance from the next message.
   */
  readonly bare?: "always" | "wide" | undefined;
}) {
  const subThread = useRowSubThread(props.rowId);
  if (subThread === null || subThread.summary.replies === 0) return null;
  return <ReplyLine {...subThread} fromUser={props.fromUser} bare={props.bare} />;
}

function ReplyLine(props: {
  readonly threadRef: ScopedThreadRef;
  readonly summary: SubThreadSummary;
  readonly fromUser: boolean;
  readonly bare: "always" | "wide" | undefined;
}) {
  const { threadRef, summary } = props;
  const states = useSubThreadStates(threadRef);
  const state = states.get(summary.first);
  const unread = unreadReplies(summary, states);
  return (
    // A user's row spaces its parts itself; an agent's row does not.
    <div
      className={cn(
        "flex max-w-full",
        !props.fromUser && "mt-1",
        props.bare === "always" && "mb-4",
        props.bare === "wide" && "@min-[37rem]:mb-4",
      )}
    >
      <button
        type="button"
        onClick={() => openSubThread(threadRef, summary.first)}
        data-sub-thread-reply-line={summary.first}
        className="flex min-w-0 max-w-full flex-col items-start gap-0.5 rounded-r-md border-border border-l-2 py-0.5 pr-2 pl-2 text-left text-xs outline-none hover:border-info hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="flex items-center gap-1.5">
          <span className="font-medium text-info-foreground">
            {summary.replies} {summary.replies === 1 ? "reply" : "replies"}
          </span>
          {unread > 0 ? (
            <span className="rounded-full bg-info px-1.5 font-medium text-3xs text-white leading-4">
              {unread} new
            </span>
          ) : null}
          <span className="text-muted-foreground tabular-nums">
            <RelativeTime timestamp={summary.lastAt} />
          </span>
        </span>
        {state?.summary ? (
          <span className="max-w-full truncate text-muted-foreground">{state.summary}</span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * The Reply slot's height with a mouse: the button's 16px less the row's bottom padding, so the
 * button stays inside the row, which the list clips. Mirrors TimelineRowContent's message padding:
 * pb-1 when grouped with the next row, pb-2 for an agent message with no meta, else pb-4.
 */
const fineSlotHeight = (row: Extract<TimelineRow, { kind: "message" }>) =>
  row.groupedWithNext
    ? "h-3"
    : row.message.role === "assistant" && !row.showAssistantMeta
      ? "h-2"
      : "h-0";

/**
 * At the end of one of the agent's main-list rows that has no reply yet: a Reply button, since the
 * user follows up on what the agent said. With a mouse it shows while the pointer is on the row, in
 * the row's bottom padding and a slot that tops it up. On a touch screen it always shows and has its
 * own height, so it stays clear of the next row.
 */
export function SubThreadReplyButton(props: {
  readonly row: Extract<TimelineRow, { kind: "message" }>;
}) {
  const subThread = useRowSubThread(props.row.id);
  if (subThread === null || props.row.message.role === "user" || subThread.summary.replies > 0)
    return null;
  const { threadRef, summary } = subThread;
  return (
    <div className={cn("relative flex pointer-coarse:h-auto", fineSlotHeight(props.row))}>
      <button
        type="button"
        onClick={() => openSubThread(threadRef, summary.first)}
        className="absolute top-0 left-0 z-10 inline-flex items-center gap-1 rounded-md bg-background px-1.5 text-muted-foreground text-xs opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover/sub-thread-row:opacity-100 pointer-coarse:static pointer-coarse:py-0.5 pointer-coarse:opacity-100"
      >
        <ReplyIcon className="size-3" />
        Reply
      </button>
    </div>
  );
}
