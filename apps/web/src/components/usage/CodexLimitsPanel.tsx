import type { ProviderRateLimits } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "../ui/button";

interface CodexLimitsPanelProps {
  readonly label: string;
  readonly now?: number;
  readonly rateLimits: ProviderRateLimits;
  readonly onUseReset: () => void;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    timestamp * 1000,
  );
}

function formatResetTime(timestamp: number | undefined, now: number): string | null {
  if (timestamp === undefined) return null;
  const minutes = Math.max(0, Math.round((timestamp * 1000 - now) / 60_000));
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets ${formatDate(timestamp)}`;
}

function LimitWindow({
  label,
  now,
  window,
}: {
  readonly label: string;
  readonly now: number;
  readonly window: NonNullable<ProviderRateLimits["primary"]>;
}) {
  const usedPercent = Math.round(window.usedPercent);
  const resetTime = formatResetTime(window.resetsAt, now);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{usedPercent}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70"
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </div>
      {resetTime ? <span className="text-xs text-muted-foreground">{resetTime}</span> : null}
    </div>
  );
}

export function CodexLimitsPanel({
  label,
  now = Date.now(),
  rateLimits,
  onUseReset,
}: CodexLimitsPanelProps) {
  const resetCredits = rateLimits.resetCredits;
  const expiresAt = resetCredits?.credits
    ?.flatMap((credit) =>
      credit.status === "available" && credit.expiresAt !== undefined ? [credit.expiresAt] : [],
    )
    .sort((left, right) => left - right)[0];
  const availableCount = resetCredits?.availableCount ?? 0;

  return (
    <section className="grid gap-5 border-y border-border py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(13rem,auto)]">
      <div className="lg:col-span-2">
        <h2 className="mb-4 text-sm font-medium text-foreground">{label} limits</h2>
        <div className="flex flex-col gap-5 sm:flex-row sm:gap-8">
          {rateLimits.primary ? (
            <LimitWindow label="5-hour limit" now={now} window={rateLimits.primary} />
          ) : null}
          {rateLimits.secondary ? (
            <LimitWindow label="Weekly limit" now={now} window={rateLimits.secondary} />
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 border-border lg:border-l lg:pl-5">
        <RotateCcwIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {availableCount === 0
              ? "No banked resets"
              : `${availableCount} banked reset${availableCount === 1 ? "" : "s"}`}
          </p>
          {expiresAt ? (
            <p className="text-xs text-muted-foreground">Next expires {formatDate(expiresAt)}</p>
          ) : null}
        </div>
        {availableCount > 0 ? (
          <Button size="sm" onClick={onUseReset}>
            Use reset
          </Button>
        ) : null}
      </div>
    </section>
  );
}
