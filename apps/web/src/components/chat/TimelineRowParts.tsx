import { type ReactNode, type ComponentProps } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { TerminalIcon, ChevronRightIcon } from "lucide-react";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";

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
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-dim-foreground text-caption tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
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

/** The fold toggle shared by the working bar and the finished turn's bar; it trails the label. */
export function WorkFoldChevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3 shrink-0 text-dim-foreground transition-transform",
        expanded && "rotate-90",
      )}
    />
  );
}

/** The bar's quiet action chip (Snooze), a feature look rather than a button variant. */
export function WorkingBarChip({
  icon,
  children,
  tone = "neutral",
  ...buttonProps
}: {
  icon: ReactNode;
  children: ReactNode;
  tone?: "neutral" | "warning";
} & Omit<ComponentProps<"button">, "className" | "children" | "type">) {
  return (
    <WorkingBarControl variant="chip" tone={tone} {...buttonProps}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </WorkingBarControl>
  );
}

/**
 * The working bar's frame: a 32px line over a hairline, shared by the bar and the fold.
 * The label starts on the assistant text's edge, 4px into the lane.
 */
export const WORKING_BAR_CLASS_NAME =
  "timeline-work-row group/timeline-row relative flex h-8 min-w-0 items-center gap-2.5 border-b border-(--timeline-working-rule,var(--border)) ps-1.25 pe-1";

/** A provider command in the timeline: in a work row's trailing slot, or opening a prompt. */
export function SlashCommandChip({ name }: { name: string }) {
  return (
    <ContextChip kind="terminal">
      <TerminalIcon aria-hidden="true" />
      <ContextChipLabel className="font-mono">{name}</ContextChipLabel>
    </ContextChip>
  );
}

/** The working bar's controls share its compact, feature-owned spacing. */
export function WorkingBarControl({
  variant,
  tone = "neutral",
  render,
  ...props
}: Omit<useRender.ComponentProps<"button">, "className"> & {
  variant: "chip" | "history" | "question";
  tone?: "neutral" | "warning";
}) {
  const defaultProps = {
    type: render ? undefined : ("button" as const),
    className: cn(
      variant === "chip"
        ? "inline-flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-row px-2 text-meta whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:pointer-events-none disabled:opacity-64 [&_svg]:size-3 [&_svg]:shrink-0"
        : variant === "history"
          ? "flex shrink-0 cursor-pointer select-none items-center gap-2 self-stretch rounded-md text-left text-label text-muted-foreground tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 disabled:cursor-default"
          : "inline-flex h-[22px] min-w-0 shrink items-center gap-1.5 rounded-row text-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 text-info-foreground cursor-pointer",
      variant === "chip" &&
        (tone === "warning"
          ? "bg-warning-foreground/10 text-warning-foreground hover:bg-warning-foreground/15"
          : "bg-badge-neutral text-muted-foreground hover:text-foreground"),
    ),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
