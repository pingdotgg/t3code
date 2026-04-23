import type { ProviderKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { formatUsd, type CostSummary } from "~/lib/costQuery";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function readBudget(): number | null {
  const raw = (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_MONTHLY_BUDGET_USD;
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatCompactUsd(value: number): string {
  if (value <= 0) return "$0";
  if (value < 1) return `¢${Math.round(value * 100)}`;
  if (value < 100) return `$${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")}`;
  if (value < 1_000) return `$${Math.round(value)}`;
  return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

function formatPercentage(value: number): string {
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/**
 * Providers whose server adapters don't yet emit token-usage events. We
 * surface "—" to avoid a misleading $0. (See c15: full provider-variance
 * UI in a follow-up commit.)
 */
const PROVIDERS_WITHOUT_USAGE_TELEMETRY = new Set<ProviderKind>(["cursor", "opencode"]);

export function CostMeter(props: {
  summary: CostSummary;
  activeProvider?: ProviderKind | null | undefined;
}) {
  const { summary, activeProvider } = props;
  const budget = readBudget();

  const sessionUsd = summary.thread?.totalUsd ?? 0;
  const sessionTurnCount = summary.thread?.turnCount ?? 0;
  const monthUsd = summary.month.totalUsd;
  const averagePerTurnUsd = sessionTurnCount > 0 ? sessionUsd / sessionTurnCount : null;
  const providerUnsupported = activeProvider
    ? PROVIDERS_WITHOUT_USAGE_TELEMETRY.has(activeProvider)
    : false;

  const ratio = providerUnsupported
    ? 0
    : budget
      ? Math.min(100, (monthUsd / budget) * 100)
      : monthUsd <= 0
        ? 0
        : Math.min(100, Math.log10(monthUsd + 1) * 25);

  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (ratio / 100) * circumference;

  const overBudget = budget ? monthUsd >= budget : false;
  const centerLabel = providerUnsupported
    ? "—"
    : monthUsd > 0
      ? formatCompactUsd(monthUsd)
      : "$0";

  const ariaLabel = providerUnsupported
    ? `Cost tracking unavailable for ${activeProvider}`
    : budget
      ? `Cost ${formatUsd(monthUsd)} of ${formatUsd(budget)} this month (${formatPercentage(ratio)})`
      : `Cost ${formatUsd(monthUsd)} this month, ${formatUsd(sessionUsd)} this session`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={ariaLabel}
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
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={overBudget ? "var(--color-destructive)" : "var(--color-muted-foreground)"}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  overBudget ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {centerLabel}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Cost
          </div>
          {providerUnsupported ? (
            <div className="text-xs text-muted-foreground">
              Usage telemetry not available for this provider.
            </div>
          ) : (
            <>
              <div className="whitespace-nowrap text-xs font-medium text-foreground">
                <span>{formatUsd(sessionUsd)}</span>
                <span className="mx-1 text-muted-foreground">session</span>
                <span className="mx-1">⋅</span>
                <span>{formatUsd(monthUsd)}</span>
                <span className="mx-1 text-muted-foreground">MTD</span>
                <span className="mx-1">⋅</span>
                <span>{formatUsd(summary.allTime.totalUsd)}</span>
                <span className="mx-1 text-muted-foreground">all-time</span>
              </div>
              {budget ? (
                <div
                  className={cn(
                    "text-xs",
                    overBudget ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  Budget: {formatUsd(budget)} ({formatPercentage(ratio)} used)
                </div>
              ) : null}
              {sessionTurnCount > 0 && averagePerTurnUsd !== null ? (
                <div className="text-xs text-muted-foreground">
                  {sessionTurnCount}
                  {sessionTurnCount === 1 ? " turn" : " turns"} this session ·{" "}
                  {formatUsd(averagePerTurnUsd)}/turn avg
                </div>
              ) : null}
              {summary.month.turnCount > 0 ? <ModelBreakdown summary={summary} /> : null}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ModelBreakdown(props: { summary: CostSummary }) {
  const entries = Object.entries(props.summary.month.byModel)
    .filter(([, entry]) => entry.totalUsd > 0 || entry.turnCount > 0)
    .sort((left, right) => right[1].totalUsd - left[1].totalUsd);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-0.5 pt-1">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/80">
        Models (this month)
      </div>
      {entries.map(([model, entry]) => (
        <div key={model} className="flex items-center justify-between gap-3 text-xs">
          <span className="truncate font-medium text-foreground">{model}</span>
          <span className="text-muted-foreground">
            {formatUsd(entry.totalUsd)} · {entry.turnCount}
            {entry.turnCount === 1 ? " turn" : " turns"}
          </span>
        </div>
      ))}
    </div>
  );
}
