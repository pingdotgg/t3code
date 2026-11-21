import { useMessages } from "gt-react";
import { type ReactNode, use } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@lathe/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { ChatEventTimestamp } from "./ChatEventTimestamp";
import { TimelineRowCtx, type TimelineRowSharedState } from "./timelineRowContext";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

/**
 * With event timestamps on, every row's time ends 6px inside the row's outer
 * edge, after any disclosure control, so the times form one column: the row's
 * end padding plus the timestamp's own end spacing add up to that edge.
 */
export function TimelineRowTimestamp({
  createdAt,
  startedAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  /** With event timestamps on, the tooltip spans from here to `createdAt`. */
  startedAt?: string | undefined;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  const m = useMessages();
  // Fork: event timestamps. Rows outside a timeline, like queued messages, have no context.
  const eventTimestamps = (use(TimelineRowCtx) as TimelineRowSharedState | null)?.eventTimestamps;
  if (eventTimestamps) {
    return (
      <ChatEventTimestamp
        iso={createdAt}
        startIso={startedAt}
        timestampFormat={timestampFormat}
        options={eventTimestamps}
        className={cn("me-1", className)}
      />
    );
  }
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
        {formatDayAwareTimestamp(createdAt, timestampFormat, undefined, undefined, m)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat, m)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className={cn("live-activity-focus-aligned block text-foreground", className)}>
          {children}
        </span>
      </span>
    </span>
  );
}
