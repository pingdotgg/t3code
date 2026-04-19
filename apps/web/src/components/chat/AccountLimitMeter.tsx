import type { AccountRateLimitsSnapshot } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { formatRelativeTimeUntilLabel } from "../../timestampFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type AccountLimitWindow = NonNullable<AccountRateLimitsSnapshot["buckets"][number]["primary"]>;

const formatPercentage = (value: number) =>
  value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;

function formatResetCopy(resetsAtIso: string | undefined): string | null {
  if (!resetsAtIso) return null;
  const label = formatRelativeTimeUntilLabel(resetsAtIso);
  return label.endsWith(" left")
    ? `Resets in ${label.slice(0, -" left".length)}`
    : `Resets ${label.toLowerCase()}`;
}

function displayBucket(snapshot: AccountRateLimitsSnapshot) {
  return (
    (snapshot.selected
      ? snapshot.buckets.find((bucket) => bucket.limitId === snapshot.selected?.limitId)
      : undefined) ??
    snapshot.buckets.find((bucket) => bucket.primary) ??
    snapshot.buckets[0]
  );
}

function limitColor(remainingPercent: number): string {
  return remainingPercent <= 10
    ? "text-destructive"
    : remainingPercent <= 25
      ? "text-amber-700 dark:text-amber-400"
      : "text-emerald-700 dark:text-emerald-400";
}

function AccountLimitWindowRow(props: { label: string; window: AccountLimitWindow }) {
  const resetCopy = formatResetCopy(props.window.resetsAtIso);
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center justify-between gap-4 text-xs">
        <span className="text-muted-foreground">{props.label}</span>
        <span className="font-medium text-foreground">
          {formatPercentage(props.window.remainingPercent)} remaining
        </span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {formatPercentage(props.window.usedPercent)} used{resetCopy ? ` · ${resetCopy}` : ""}
      </div>
    </div>
  );
}

export function AccountLimitMeter(props: { snapshot: AccountRateLimitsSnapshot }) {
  const bucket = displayBucket(props.snapshot);
  const primaryWindow = bucket?.primary;
  if (!primaryWindow) return null;

  const rows = [
    ...(bucket.primary ? [{ label: "Session", window: bucket.primary }] : []),
    ...(bucket.secondary ? [{ label: "Weekly", window: bucket.secondary }] : []),
  ];
  const usedLabel = formatPercentage(primaryWindow.usedPercent);
  const remainingLabel = formatPercentage(primaryWindow.remainingPercent);
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset =
    circumference - (Math.max(0, Math.min(100, primaryWindow.usedPercent)) / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85",
              limitColor(primaryWindow.remainingPercent),
            )}
            aria-label={`Account limit ${usedLabel} used, ${remainingLabel} remaining`}
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, currentColor 25%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span className="relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium">
                {Math.round(primaryWindow.usedPercent)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Account limit
          </div>
          <div className="grid min-w-36 gap-2">
            {rows.map((row) => (
              <AccountLimitWindowRow key={row.label} {...row} />
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
