import { formatPercent } from "@t3tools/shared/usageFormat";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface ShareSegment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/**
 * One part-to-whole bar with its legend, for cost or tokens split by type or
 * speed. Empty segments are left out, and nothing renders without a total.
 */
export function UsageShareBar({
  label,
  segments,
  format,
  aside,
}: {
  readonly label: string;
  readonly segments: readonly ShareSegment[];
  readonly format: (value: number) => string;
  readonly aside?: ReactNode;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        {aside}
      </div>
      <div
        role="img"
        aria-label={`${label}: ${visible.map((segment) => `${segment.label} ${format(segment.value)}`).join(", ")}`}
        className="flex h-2 gap-0.5"
      >
        {visible.map((segment) => (
          <Tooltip key={segment.label}>
            <TooltipTrigger
              render={
                <div
                  className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
                  style={{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }}
                />
              }
            />
            <TooltipPopup>
              {segment.label} · {format(segment.value)} · {formatPercent(segment.value / total)}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {visible.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-xs"
              style={{ backgroundColor: segment.color }}
            />
            <span className="text-muted-foreground">{segment.label}</span>
            <span className="text-foreground tabular-nums">{format(segment.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
