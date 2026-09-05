import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { usePrimarySettings } from "~/hooks/useSettings";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import type { ComposerUsageMeterModel } from "./ComposerUsageMeter.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number): string {
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function usageMeterTextClass(percent: number): string {
  if (percent >= 90) return "text-destructive";
  if (percent >= 70) return "text-warning";
  return "text-muted-foreground";
}

function usageBarClass(percent: number): string {
  if (percent >= 90) return "bg-destructive";
  if (percent >= 70) return "bg-warning";
  return "bg-foreground";
}

const utcDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Reset instant for one quota window. Date-only UTC sources (Cursor's panel
 * is date-only, stored as UTC midnight) render as a plain date — including
 * a clock would invent a local time like 5:30 AM.
 */
function formatWindowReset(
  resetsAt: string | undefined,
  timestampFormat: TimestampFormat,
): string | null {
  if (!resetsAt) return null;
  if (/T00:00:00(?:\.000)?Z$/.test(resetsAt)) {
    const date = new Date(resetsAt);
    return Number.isNaN(date.getTime()) ? null : utcDateFormatter.format(date);
  }
  const formatted = formatUpcomingTimestamp(resetsAt, timestampFormat);
  return formatted.length > 0 ? formatted : null;
}

export function ComposerUsageBars(props: {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly className?: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { usageLimits } = props;

  if (usageLimits.unavailable || usageLimits.windows.length === 0) return null;

  return (
    <div className={cn("grid gap-3", props.className)}>
      {usageLimits.windows.map((window) => {
        // The bar width and the "% remaining" label must derive from the same
        // rounded number. Deriving the label from a rounded value and the bar
        // from the raw one makes 99.6% read as "0% remaining" next to a bar
        // that is visibly not full.
        const roundedPercent = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
        const remainingPercent = 100 - roundedPercent;
        const reset = formatWindowReset(window.resetsAt, timestampFormat);

        return (
          <div key={window.id} className="grid gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">{window.label}</span>
              <span className="text-muted-foreground">{remainingPercent}% remaining</span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={`${window.label} usage ${roundedPercent}% used`}
              aria-valuenow={roundedPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={cn("h-full rounded-full", usageBarClass(window.usedPercent))}
                style={{ width: `${roundedPercent}%` }}
              />
            </div>
            {reset ? <div className="text-[11px] text-muted-foreground">Resets {reset}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

export function ComposerProviderUsageDetails(props: { usage: ComposerUsageMeterModel }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Usage</div>
        <div className="truncate text-secondary-label text-[11px]">{props.usage.providerLabel}</div>
      </div>
      <ComposerUsageBars usageLimits={props.usage.usageLimits} className="gap-2" />
    </div>
  );
}

export function ComposerUsageMeter(props: { usage: ComposerUsageMeterModel }) {
  const { usage } = props;
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercent));
  const usedPercentage = formatPercentage(normalizedPercentage);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="sm"
            variant="ghost-muted"
            className="h-7 rounded-full px-2 hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={`${usage.providerLabel} usage ${usedPercentage} used`}
          >
            <span
              className={cn(
                "text-[11px] tabular-nums font-medium",
                usageMeterTextClass(normalizedPercentage),
              )}
            >
              {usedPercentage}
            </span>
          </Button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <ComposerProviderUsageDetails usage={usage} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
