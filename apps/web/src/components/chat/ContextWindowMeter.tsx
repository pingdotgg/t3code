import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { contextWindowSegments } from "./compaction.logic";
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
