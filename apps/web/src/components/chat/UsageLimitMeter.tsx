import { cn } from "~/lib/utils";
import {
  type UsageLimitsSnapshot,
  formatUsageLimitPercent,
  formatUsageLimitPlanType,
  formatUsageLimitReason,
  formatUsageLimitResetLabel,
  formatUsageLimitWindowLabel,
  isUsageLimitWindowExpired,
  selectHeadlineUsageLimitWindow,
} from "~/lib/usageLimits";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const MUTED_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
const TRACK_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";

function usageColor(usedPercent: number, limited: boolean): string {
  return limited || usedPercent > 90 ? "var(--color-error)" : MUTED_COLOR;
}

export function UsageLimitMeter(props: {
  usage: UsageLimitsSnapshot;
  providerDisplayName?: string | null;
  nowMs?: number;
}) {
  const { usage, providerDisplayName } = props;
  const nowMs = props.nowMs ?? Date.now();
  const headline = selectHeadlineUsageLimitWindow(usage, nowMs);
  const isLimited = usage.status === "limited";
  const headlinePercent = isLimited ? 100 : (headline?.usedPercent ?? 0);
  const glyphColor = usageColor(headlinePercent, isLimited);
  const limitReason = formatUsageLimitReason(usage.limitReason);
  const planType = formatUsageLimitPlanType(usage.planType);
  const headlineReset = headline ? formatUsageLimitResetLabel(headline.resetsAt, nowMs) : null;
  const ariaLabel = isLimited
    ? `Usage limit reached${headlineReset ? `, ${headlineReset.toLowerCase()}` : ""}`
    : headline
      ? `${formatUsageLimitWindowLabel(headline)} usage limit ${formatUsageLimitPercent(headline.usedPercent)} used${headlineReset ? `, ${headlineReset.toLowerCase()}` : ""}`
      : "Usage limits";

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
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={ariaLabel}
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg viewBox="0 0 24 24" className="size-full" aria-hidden="true">
                <rect
                  x="3"
                  y="8"
                  width="18"
                  height="8"
                  rx="2.5"
                  fill="none"
                  stroke={TRACK_COLOR}
                  strokeWidth="2"
                />
                <rect
                  x="5.5"
                  y="10.5"
                  width={Math.max(0, (13 * Math.min(100, headlinePercent)) / 100)}
                  height="3"
                  rx="1"
                  fill={glyphColor}
                  className="transition-[width,fill] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2.5 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Usage limits</div>
            {planType || providerDisplayName ? (
              <div className="truncate text-secondary-label text-[11px]">
                {[providerDisplayName, planType].filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </div>

          {isLimited ? (
            <div className="text-pretty font-medium text-[11px] text-error">
              {limitReason ?? "Usage limit reached"}
              {headlineReset ? ` · ${headlineReset}` : ""}
            </div>
          ) : null}

          {usage.windows.length === 0 ? (
            <div className="text-secondary-label text-[11px]">No usage window reported yet.</div>
          ) : null}

          {usage.windows.map((window) => {
            const expired = isUsageLimitWindowExpired(window, nowMs);
            const usedPercent = expired ? 0 : window.usedPercent;
            const resetLabel = formatUsageLimitResetLabel(window.resetsAt, nowMs);
            const color = usageColor(usedPercent, false);
            return (
              <div key={window.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-secondary-label">
                    {formatUsageLimitWindowLabel(window)}
                  </span>
                  <span className="font-medium tabular-nums text-secondary-label">
                    {formatUsageLimitPercent(usedPercent)}
                    {resetLabel ? (
                      <>
                        <span className="mx-1 font-normal">·</span>
                        <span className="font-normal">{resetLabel}</span>
                      </>
                    ) : null}
                  </span>
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(usedPercent)}
                  aria-label={`${formatUsageLimitWindowLabel(window)} usage`}
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${usedPercent}%`, backgroundColor: color }}
                  />
                </div>
              </div>
            );
          })}

          {usage.spendLimit ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Spend limit</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {usage.spendLimit.used} / {usage.spendLimit.limit}
              </span>
            </div>
          ) : null}

          {usage.credits && !usage.credits.unlimited ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Credits</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {usage.credits.balance ?? (usage.credits.hasCredits ? "Available" : "None")}
              </span>
            </div>
          ) : null}

          {usage.overage ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Overage</span>
              <span className="font-medium text-secondary-label">
                {usage.overage.status === "limited"
                  ? "Unavailable"
                  : usage.overage.inUse
                    ? "In use"
                    : "Available"}
              </span>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
