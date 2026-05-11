import { type ProviderUsageSnapshot } from "~/lib/providerUsage";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatResetTime(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null;
  }
  const date = new Date(resetsAt * 1000);
  return `Resets ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}, ${date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}`;
}

function UsageBar(props: { percent: number; status: "ok" | "warning" | "rejected" }) {
  const barColor =
    props.status === "rejected" || props.percent >= 90
      ? "bg-red-500"
      : props.status === "warning" || props.percent >= 70
        ? "bg-amber-500"
        : "bg-rose-500";

  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/50">
      <div
        className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out ${barColor}`}
        style={{ width: `${Math.min(100, Math.max(0, props.percent))}%` }}
      />
    </div>
  );
}

function BarGraphIcon(props: { status: "ok" | "warning" | "rejected" }) {
  const barColor =
    props.status === "rejected"
      ? "var(--color-destructive)"
      : props.status === "warning"
        ? "var(--color-warning, #f59e0b)"
        : "var(--color-muted-foreground)";

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <rect x="4" y="13" width="4" height="7" rx="1" fill={barColor} opacity={0.6} />
      <rect x="10" y="8" width="4" height="12" rx="1" fill={barColor} opacity={0.8} />
      <rect x="16" y="4" width="4" height="16" rx="1" fill={barColor} />
    </svg>
  );
}

export function ProviderUsageMeter(props: { usage: ProviderUsageSnapshot }) {
  const { usage } = props;
  const maxPercent = Math.max(...usage.windows.map((w) => w.usedPercent), 0);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full p-0.5 transition-opacity hover:opacity-85"
            aria-label={`${usage.providerLabel} usage: ${Math.round(maxPercent)}%`}
          >
            <BarGraphIcon status={usage.status} />
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none px-4 py-3">
        <div className="space-y-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {usage.providerLabel}
          </div>

          {usage.windows.map((window) => {
            const resetText = formatResetTime(window.resetsAt);
            return (
              <div key={window.label} className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs font-semibold text-foreground">{window.label}</span>
                  <span className="text-xs font-semibold text-foreground">
                    {Math.round(window.usedPercent)}%
                  </span>
                </div>
                <UsageBar percent={window.usedPercent} status={usage.status} />
                {resetText ? (
                  <div className="text-[11px] text-muted-foreground">{resetText}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
