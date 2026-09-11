import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { LimitWindows } from "../usage/UsageLimits";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  USAGE_LIMIT_METER_WARNING_PERCENT,
  type UsageLimitMeterModel,
  formatUsageLimitMeterLabel,
  selectHeadlineUsageWindow,
} from "./UsageLimitMeter.logic";
import { remainingPercent } from "@t3tools/shared/usageLimits";

/**
 * The selected provider's subscription limits, always in the composer footer
 * beside the context window ring. The glyph is a level: its fill is the quota
 * left in the tightest window, the way Usage → Limits draws its bars. Hover
 * for every window with pace and reset countdown.
 */
export function UsageLimitMeter(props: { model: UsageLimitMeterModel; now?: number }) {
  const { model } = props;
  const now = props.now ?? Date.now();
  const headline = selectHeadlineUsageWindow(model.limits.windows, now);
  const remaining = headline ? remainingPercent(headline) : 100;
  const isLow = headline !== null && remaining <= USAGE_LIMIT_METER_WARNING_PERCENT;
  const fillColor = isLow
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  const driverLabel = getDriverOption(model.driver)?.label ?? String(model.driver);
  const accountLabel = [
    model.displayName && model.displayName.toLowerCase() !== driverLabel.toLowerCase()
      ? `${driverLabel} · ${model.displayName}`
      : driverLabel,
    model.plan,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={formatUsageLimitMeterLabel(model, now)}
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg viewBox="0 0 24 24" className="size-full mx-0!" aria-hidden="true">
                <rect
                  x="3"
                  y="8"
                  width="18"
                  height="8"
                  rx="2.5"
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="2"
                />
                <rect
                  x="5.5"
                  y="10.5"
                  width={(13 * remaining) / 100}
                  height="3"
                  rx="1"
                  fill={fillColor}
                  className="transition-[width,fill] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-80 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Usage limits</div>
            <div className="truncate text-secondary-label text-[11px]">{accountLabel}</div>
          </div>
          <LimitWindows compact driver={model.driver} windows={model.limits.windows} now={now} />
          <div className="text-pretty text-secondary-label text-[11px]">
            Every account and reset credit is under Usage → Limits.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
