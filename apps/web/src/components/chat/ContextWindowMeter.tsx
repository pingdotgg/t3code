import { Button } from "../ui/button";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  contextWindowSegments,
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { ReactElement } from "react";
import { cn } from "~/lib/utils";

/** The details row can reserve visible notches without changing the used/max fill. */
export function ContextWindowSegments({
  usage,
  minSegmentWidth = 0,
}: {
  usage: ContextWindowSnapshot;
  minSegmentWidth?: number;
}) {
  const percentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const segments = contextWindowSegments(usage);
  const largest = segments.reduce((max, segment) => Math.max(max, segment.tokens), 0);
  const largestIndex = segments.findIndex((segment) => segment.tokens === largest);
  // When the entire used fill is tiny, scale gaps and minimums down together.
  const gap = `min(1px, calc(100% / ${segments.length * 2 - 1}))`;
  const available = `(100% - ${segments.length - 1} * ${gap})`;
  const minimum = `min(${minSegmentWidth}px, calc(${available} / ${segments.length}))`;
  return (
    <span
      className="block h-1 min-w-0 overflow-hidden rounded-full bg-black/10 dark:bg-white/[0.063]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percentage)}
      aria-label="Context window usage"
    >
      <span
        className="flex h-full gap-px overflow-hidden"
        style={{ width: `${percentage}%`, ...(minSegmentWidth > 0 ? { gap } : {}) }}
      >
        {segments.map((segment, index) => (
          <span
            key={segment.label}
            className={cn("h-full min-w-0 basis-0", segment.color)}
            style={
              minSegmentWidth > 0
                ? {
                    minWidth: minimum,
                    flexGrow: index === largestIndex ? 1 : 0,
                    flexBasis:
                      index === largestIndex
                        ? 0
                        : `max(${minimum}, calc(${available} * ${segment.tokens / Math.max(1, usage.usedTokens)}))`,
                  }
                : { flexGrow: segment.tokens }
            }
          />
        ))}
      </span>
    </span>
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
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  trigger?: ReactElement;
  side?: "top" | "left";
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--error-foreground)" : "var(--muted-foreground)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          props.trigger ?? (
            <Button
              size="icon-sm"
              variant="ghost-muted"
              className="size-7"
              aria-label={
                usage.maxTokens !== null && usedPercentage
                  ? `Context window ${usedPercentage} used`
                  : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
              }
            >
              <span className="relative flex size-5 items-center justify-center">
                <svg
                  viewBox="0 0 24 24"
                  className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    className="stroke-border"
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
                    className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                  />
                </svg>
              </span>
            </Button>
          )
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side={props.side ?? "top"}
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="text-label text-muted-foreground">Context window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-meta text-right tabular-nums">
                <span>{usedPercentage}</span>
                <br />
                <span>
                  {formatContextWindowTokens(usage.usedTokens)} /{" "}
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-meta tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? <ContextWindowSegments usage={usage} /> : null}
          <dl className="flex flex-col gap-1 text-meta text-secondary-label">
            {contextWindowSegments(usage).map((segment) => (
              <div key={segment.label} className="flex items-center justify-between gap-3">
                <dt className="flex items-center gap-2">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", segment.color)} />
                  {segment.label}
                </dt>
                <dd className="tabular-nums">{segment.tokens.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-meta">
              <span className="text-secondary-label">Total processed</span>
              <span className="tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-meta">
              <span className="text-secondary-label">Cost</span>
              <span className="tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-meta">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="secondary"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-meta">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
