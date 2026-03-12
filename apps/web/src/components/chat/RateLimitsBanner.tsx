import type { RateLimitsInfo } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function formatResetTime(resetsAtUnix: number): string {
  const now = Date.now() / 1000;
  const diffSeconds = Math.max(0, resetsAtUnix - now);
  if (diffSeconds < 60) return "< 1m";
  if (diffSeconds < 3600) return `${Math.ceil(diffSeconds / 60)}m`;
  if (diffSeconds < 86400) {
    const hours = Math.floor(diffSeconds / 3600);
    const mins = Math.ceil((diffSeconds % 3600) / 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.ceil((diffSeconds % 86400) / 3600);
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function windowLabel(durationMins: number): string {
  if (durationMins <= 60) return `${durationMins}m`;
  if (durationMins < 1440) return `${Math.round(durationMins / 60)}h`;
  return `${Math.round(durationMins / 1440)}d`;
}

function barColor(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-red-500";
  if (usedPercent >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function RateLimitBar({
  label,
  usedPercent,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  resetsAt: number;
}) {
  const remaining = Math.max(0, 100 - usedPercent);
  const resetLabel = formatResetTime(resetsAt);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
            <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${barColor(usedPercent)}`}
                style={{ width: `${remaining}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {remaining}%
            </span>
          </div>
        }
      />
      <TooltipPopup side="bottom">
        {remaining}% remaining · resets in {resetLabel}
      </TooltipPopup>
    </Tooltip>
  );
}

export const RateLimitsBanner = memo(function RateLimitsBanner({
  rateLimits,
}: {
  rateLimits: RateLimitsInfo | null;
}) {
  const windows = useMemo(() => {
    if (!rateLimits) return null;
    const result: Array<{
      key: string;
      label: string;
      usedPercent: number;
      resetsAt: number;
    }> = [];
    if (rateLimits.primary) {
      result.push({
        key: "primary",
        label: windowLabel(rateLimits.primary.windowDurationMins),
        usedPercent: rateLimits.primary.usedPercent,
        resetsAt: rateLimits.primary.resetsAt,
      });
    }
    if (rateLimits.secondary) {
      result.push({
        key: "secondary",
        label: windowLabel(rateLimits.secondary.windowDurationMins),
        usedPercent: rateLimits.secondary.usedPercent,
        resetsAt: rateLimits.secondary.resetsAt,
      });
    }
    return result.length > 0 ? result : null;
  }, [rateLimits]);

  if (!windows) return null;

  return (
    <div className="mx-auto flex max-w-3xl items-center gap-3 px-3 pt-1.5 sm:px-5">
      <span className="shrink-0 text-[10px] font-medium text-muted-foreground">Rate limits</span>
      {windows.map((w) => (
        <RateLimitBar
          key={w.key}
          label={w.label}
          usedPercent={w.usedPercent}
          resetsAt={w.resetsAt}
        />
      ))}
    </div>
  );
});
