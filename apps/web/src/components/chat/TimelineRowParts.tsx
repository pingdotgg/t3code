import { type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

export const MESSAGE_HEADING_LEVEL = 3;

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

/** Quiet label above a message bubble, such as "Steer" or "Voice"; the tooltip holds the detail. */
export function TimelineMessageMarker({
  icon: Icon,
  label,
  tooltip,
  ariaLabel,
  align,
  dataAttributes,
}: {
  icon: LucideIcon;
  label: string;
  tooltip: ReactNode;
  /** Replaces the visible label for screen readers. */
  ariaLabel?: string;
  align: "start" | "end";
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex items-center gap-1 text-xs leading-none text-muted-foreground",
              align === "end" ? "me-1 justify-end" : "justify-start",
            )}
            {...(ariaLabel === undefined ? {} : { role: "img", "aria-label": ariaLabel })}
            {...dataAttributes}
          />
        }
      >
        <Icon aria-hidden="true" className="size-3" />
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
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
