import { MICRO_FADE_MOTION_CLASS_NAME } from "~/lib/motion";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  variant?: "icon" | "labeled";
}) {
  const { usage } = props;
  const variant = props.variant ?? "icon";
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const visibleLabel = usedPercentage ?? formatContextWindowTokens(usage.usedTokens);
  const isLabeledVariant = variant === "labeled";
  const meterSizeClassName = isLabeledVariant ? "h-5 w-5" : "h-6 w-6";
  const trackStroke = isLabeledVariant
    ? "color-mix(in oklab, var(--color-accent) 24%, transparent)"
    : "color-mix(in oklab, var(--color-muted) 70%, transparent)";
  const progressStroke = isLabeledVariant ? "var(--color-accent)" : "var(--color-muted-foreground)";

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
              "group inline-flex items-center justify-center hover:opacity-85",
              MICRO_FADE_MOTION_CLASS_NAME,
              isLabeledVariant ? "gap-1 rounded-md px-1 py-0.5" : "rounded-full",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className={cn("relative flex items-center justify-center", meterSizeClassName)}>
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
                  stroke={trackStroke}
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={progressStroke}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] [transition-duration:var(--motion-duration-ui)] [transition-timing-function:var(--motion-ease-out)] motion-reduce:transition-none"
                />
              </svg>
              {!isLabeledVariant ? (
                <span
                  className={cn(
                    "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                    "text-muted-foreground",
                  )}
                >
                  {usage.usedPercentage !== null
                    ? Math.round(usage.usedPercentage)
                    : formatContextWindowTokens(usage.usedTokens)}
                </span>
              ) : null}
            </span>
            {isLabeledVariant ? (
              <span className="text-muted-foreground text-xs">{visibleLabel}</span>
            ) : null}
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">⋅</span>
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
              <span>/</span>
              <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
            </div>
          ) : (
            <div className="text-sm text-foreground">
              {formatContextWindowTokens(usage.usedTokens)} tokens used so far
            </div>
          )}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
              tokens
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-xs text-muted-foreground">
              Automatically compacts its context when needed.
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
