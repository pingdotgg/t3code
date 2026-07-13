import { deriveCacheStats } from "@t3tools/shared/tokenAccounting";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatCostUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (value > 0 && value < 0.01) {
    return "<$0.01";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function accountingStatusLabel(value: ContextWindowSnapshot["accountingStatus"]): string | null {
  switch (value) {
    case "exact":
      return "Exact";
    case "provider-reported":
      return "Provider reported";
    case "estimated":
      return "Estimated";
    case "partial":
      return "Partial";
    case "unavailable":
      return "Unpriced";
    default:
      return null;
  }
}

function UsageRow(props: { label: string; value: number | null | undefined }) {
  if (props.value === null || props.value === undefined || props.value <= 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className="text-muted-foreground/60">{props.label}</span>
      <span className="font-medium tabular-nums text-muted-foreground/80">
        {formatContextWindowTokens(props.value)}
      </span>
    </div>
  );
}

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
  providerDisplayName?: string | null;
}) {
  const { usage, providerDisplayName } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const cacheStats = deriveCacheStats({
    usedTokens: usage.usedTokens,
    ...(usage.inputTokens !== null && usage.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage.uncachedInputTokens !== null && usage.uncachedInputTokens !== undefined
      ? { uncachedInputTokens: usage.uncachedInputTokens }
      : {}),
    ...(usage.cachedInputTokens !== null && usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheCreationInputTokens !== null && usage.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
  });
  const cacheHitPercentage = formatPercentage(
    cacheStats.cacheHitRatio !== null ? cacheStats.cacheHitRatio * 100 : null,
  );
  const costLabel = formatCostUsd(usage.cost?.totalCostUsd);
  const accountingLabel = accountingStatusLabel(usage.accountingStatus);
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--color-red-500)" : "var(--color-blue-500)";

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
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-4 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-muted-foreground/60">Total processed</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-1 border-muted/70 border-t pt-2">
            <UsageRow label="Input" value={usage.lastInputTokens ?? usage.inputTokens} />
            <UsageRow
              label="Uncached input"
              value={usage.lastUncachedInputTokens ?? cacheStats.uncachedInputTokens}
            />
            <UsageRow
              label="Cached input"
              value={usage.lastCachedInputTokens ?? cacheStats.cachedInputTokens}
            />
            <UsageRow
              label="Cache write"
              value={usage.lastCacheCreationInputTokens ?? usage.cacheCreationInputTokens}
            />
            <UsageRow
              label="Cache read"
              value={usage.lastCacheReadInputTokens ?? usage.cacheReadInputTokens}
            />
            <UsageRow label="Output" value={usage.lastOutputTokens ?? usage.outputTokens} />
            <UsageRow
              label="Reasoning output"
              value={usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens}
            />
            {cacheHitPercentage ? (
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/60">Cache hit ratio</span>
                <span className="font-medium tabular-nums text-muted-foreground/80">
                  {cacheHitPercentage}
                </span>
              </div>
            ) : null}
            {costLabel ? (
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/60">Cost</span>
                <span className="font-medium tabular-nums text-muted-foreground/80">
                  {costLabel}
                </span>
              </div>
            ) : null}
            {accountingLabel ? (
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/60">Accounting</span>
                <span className="font-medium text-muted-foreground/80">{accountingLabel}</span>
              </div>
            ) : null}
          </div>
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
              {providerDisplayName ?? "It"} automatically compacts its context when needed.
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
