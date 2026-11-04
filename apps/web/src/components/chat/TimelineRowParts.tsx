import type { MessageId } from "@t3tools/contracts";
import { InlineButton } from "../ui/button";
import { copyMessageLink } from "../promptLinks/copyPromptLink";
import { TimelineRowCtx } from "./timelineRowContext";
import { use, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

/** A message's time. Clicking it copies a link that opens the thread at this message. */
export function MessageTimestamp({
  messageId,
  time,
  linkable,
}: {
  messageId: MessageId;
  time: string;
  linkable: boolean;
}) {
  const ctx = use(TimelineRowCtx);
  const threadRef = linkable ? ctx.threadRef : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          threadRef ? (
            <InlineButton
              tone="muted"
              aria-label={`Copy link to message from ${formatChatTimestampTooltip(time, ctx.timestampFormat)}`}
              onClick={() => void copyMessageLink(threadRef, messageId)}
            />
          ) : (
            <p className="text-muted-foreground text-xs tabular-nums" />
          )
        }
      >
        {formatDayAwareTimestamp(time, ctx.timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>
        {formatChatTimestampTooltip(time, ctx.timestampFormat)}
        {threadRef ? <p className="text-muted-foreground">Click to copy a link</p> : null}
      </TooltipPopup>
    </Tooltip>
  );
}
