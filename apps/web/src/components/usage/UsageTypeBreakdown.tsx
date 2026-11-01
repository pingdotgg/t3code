import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { costTypeSegments } from "./usageBreakdown";
import {
  categoryCostOf,
  formatShare,
  tokensOf,
  type UsageExplorerMetric,
  type UsageTotals,
} from "./usageExplorerModel";

interface TypeColumn {
  readonly label: string;
  readonly color: string;
  readonly costUsd: number;
  /** Null for cost no token type accounts for. */
  readonly tokens: number | null;
  /** Facts about this type alone, keyed for rendering. */
  readonly notes: Readonly<Record<string, ReactNode>>;
}

/**
 * Where the tokens and the money went, by token type: one bar, then a column
 * per type with its cost, tokens and share. It holds the page's totals too,
 * so processed, cached, uncached and output tokens and the cache savings each
 * appear once, beside the type they belong to.
 */
export function UsageTypeBreakdown({
  total,
  metric,
  perActive,
}: {
  readonly total: UsageTotals;
  readonly metric: UsageExplorerMetric;
  /** Average processed tokens over the active hours or days, and which. */
  readonly perActive: { readonly tokens: number; readonly unit: "hour" | "day" };
}) {
  const input = total.input + total.cacheRead + total.cacheWrite;
  const ofInput = (tokens: number) => `${formatShare(input === 0 ? 0 : tokens / input)} of input`;
  const cost = categoryCostOf(total);
  const colors = new Map(costTypeSegments(cost).map((segment) => [segment.label, segment.color]));
  const color = (label: string) => colors.get(label) ?? "var(--muted-foreground)";
  const columns: TypeColumn[] = [
    {
      label: "Uncached input",
      color: color("Input"),
      costUsd: cost.input,
      tokens: total.input,
      notes: {},
    },
    {
      label: "Cache read",
      color: color("Cache read"),
      costUsd: cost.cacheRead,
      tokens: total.cacheRead,
      notes: {
        share: ofInput(total.cacheRead),
        savings:
          total.cacheSavingsUsd > 0 ? (
            <Hint
              text={`Uncached, the same work would list at ${formatUsd(total.costUsd + total.cacheSavingsUsd)}`}
            >
              Saved {formatUsd(total.cacheSavingsUsd)}
            </Hint>
          ) : null,
      },
    },
    {
      label: "Cache write",
      color: color("Cache write"),
      costUsd: cost.cacheWrite,
      tokens: total.cacheWrite,
      notes: {},
    },
    {
      label: "Output",
      color: color("Output"),
      costUsd: cost.output,
      tokens: total.output,
      notes: {
        reasoning: total.reasoning > 0 ? `${formatTokens(total.reasoning)} reasoning` : null,
      },
    },
  ];
  // Reported cost with no rates to split it; below a cent it is rounding.
  if (cost.unsplit >= 0.005) {
    columns.push({
      label: "Other",
      color: color("Other"),
      costUsd: cost.unsplit,
      tokens: null,
      notes: { why: "Reported cost without rates to split it" },
    });
  }
  const value = (column: TypeColumn) => (metric === "cost" ? column.costUsd : (column.tokens ?? 0));
  const whole = columns.reduce((sum, column) => sum + value(column), 0);
  const shown = columns.filter((column) => value(column) > 0 || (column.tokens ?? 0) > 0);
  // Reported cost can come without token counts; its Other column explains it.
  if (tokensOf(total) === 0 && (metric === "tokens" || total.costUsd <= 0)) return null;
  const title = metric === "cost" ? "Cost by type" : "Tokens by type";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground">{formatTokens(tokensOf(total))}</span> processed tokens
          {" · "}
          <Hint text={`Averaged over the ${perActive.unit}s that had any usage, not elapsed time`}>
            {formatTokens(perActive.tokens)} per active {perActive.unit}
          </Hint>
        </span>
      </div>
      <div
        role="img"
        aria-label={`${title}: ${shown.map((column) => `${column.label} ${format(metric, value(column))}`).join(", ")}`}
        className="flex h-2 gap-0.5"
      >
        {shown
          .filter((column) => value(column) > 0)
          .map((column) => (
            <div
              key={column.label}
              className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
              style={{ flex: `${value(column)} 1 0`, backgroundColor: column.color }}
            />
          ))}
      </div>
      <div
        className={cn(
          "grid grid-cols-2 gap-x-6 gap-y-4",
          shown.length >= 5
            ? "md:grid-cols-5"
            : shown.length === 4
              ? "md:grid-cols-4"
              : "md:grid-cols-3",
        )}
      >
        {shown.map((column) => (
          <div key={column.label} className="flex min-w-0 flex-col gap-0.5 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-xs"
                style={{ backgroundColor: column.color }}
              />
              {column.label}
            </span>
            <span className="text-base font-medium text-foreground tabular-nums">
              {format(metric, value(column))}
              <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                {formatShare(whole === 0 ? 0 : value(column) / whole)}
              </span>
            </span>
            {column.tokens !== null ? (
              <span className="text-muted-foreground tabular-nums">
                {metric === "cost"
                  ? `${formatTokens(column.tokens)} tokens`
                  : formatUsd(column.costUsd)}
              </span>
            ) : null}
            {Object.entries(column.notes).map(([key, note]) =>
              note === null ? null : (
                <span key={key} className="text-muted-foreground tabular-nums">
                  {note}
                </span>
              ),
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const format = (metric: UsageExplorerMetric, value: number) =>
  metric === "cost" ? formatUsd(value) : formatTokens(value);

function Hint({ text, children }: { readonly text: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default" />}>{children}</TooltipTrigger>
      <TooltipPopup className="max-w-72">{text}</TooltipPopup>
    </Tooltip>
  );
}
