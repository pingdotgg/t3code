import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { getTimestampFormatOptions, parseTimestampDate } from "~/timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts/settings";

function usageColor(usedPercent: number): string {
  if (usedPercent >= 90) return "bg-red-500";
  if (usedPercent >= 70) return "bg-amber-500";
  return "bg-blue-500";
}

function formatResetTimestamp(resetsAt: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(resetsAt);
  if (!date) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...getTimestampFormatOptions(timestampFormat, false),
  }).format(date);
}

export function ProviderUsageRows(props: {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly timestampFormat: TimestampFormat;
  readonly compact?: boolean;
}) {
  return (
    <div className={cn("grid", props.compact ? "gap-2.5" : "gap-3")}>
      {props.usageLimits.windows.map((window) => {
        const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
        const remainingPercent = Math.max(0, Math.round(100 - usedPercent));
        const resetLabel = window.resetsAt
          ? formatResetTimestamp(window.resetsAt, props.timestampFormat)
          : "";
        return (
          <div
            key={`${window.label}:${window.windowDurationMins ?? "unknown"}:${window.resetsAt ?? "unknown"}`}
            className="grid gap-1.5"
          >
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">{window.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {remainingPercent}% remaining
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-label={`${window.label} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usedPercent)}
              aria-valuetext={`${remainingPercent}% remaining`}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  usageColor(usedPercent),
                )}
                style={{ width: `${usedPercent}%` }}
              />
            </div>
            {resetLabel ? (
              <div className="text-[11px] text-muted-foreground/70">Resets at {resetLabel}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function ProviderUsageSummary(props: { readonly usageLimits: ServerProviderUsageLimits }) {
  const summaryItems = props.usageLimits.windows.map((window) => ({
    key: `${window.label}:${window.windowDurationMins ?? "unknown"}:${window.resetsAt ?? "unknown"}`,
    label: window.label,
    remainingPercent: Math.max(0, Math.round(100 - window.usedPercent)),
  }));
  return (
    <p className="min-w-0 text-[11px] text-muted-foreground/80">
      {summaryItems.map((item, index) => (
        <span key={item.key} className="whitespace-nowrap">
          {index > 0 ? <span className="mx-1.5 text-muted-foreground/40">·</span> : null}
          <span>{item.label}</span>{" "}
          <span className="tabular-nums text-muted-foreground">{item.remainingPercent}%</span>
        </span>
      ))}
      <span className="text-muted-foreground/60"> remaining</span>
    </p>
  );
}
