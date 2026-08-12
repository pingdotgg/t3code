/**
 * Account rate-limit views: the sidebar hover card and the usage page's
 * "Limits" strip. Both render whatever windows the server reports, so a
 * window a provider adds or brings back (Codex's paused 5-hour) appears
 * without a client change.
 *
 * Every percentage is labelled `used` inline - a bare number cannot say
 * whether it is used or remaining. Snapshot age only renders once the data
 * is actually stale; fresh data needs no caption.
 *
 * @module AccountLimits
 */
import type {
  AccountLimitsSnapshot,
  AccountLimitsWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useAccountLimits } from "../../state/accountLimits";
import { formatAgo, formatResetAt, formatSidebarResetAt } from "../../usage/limitsFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

/** Age past which a snapshot stops being "current" and earns a caption. */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Reset countdowns and snapshot ages drift as time passes, not as data
 * changes; a coarse tick keeps them honest without re-fetching.
 */
function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

function usageTone(usedPercent: number): string | undefined {
  if (usedPercent >= 95) return "text-red-400";
  if (usedPercent >= 80) return "text-amber-400";
  return undefined;
}

function remainingTone(usedPercent: number): string {
  if (usedPercent >= 95) return "text-red-400";
  if (usedPercent >= 80) return "text-amber-400";
  return "text-sidebar-foreground/70";
}

function compactWindowLabel(window: AccountLimitsWindow): string {
  if (window.windowMinutes === null) return window.label;
  if (window.windowMinutes % 1_440 === 0) return `${window.windowMinutes / 1_440}d`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}h`;
  return `${window.windowMinutes}m`;
}

function LimitMeter({ window, color }: { window: AccountLimitsWindow; color: string }) {
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}

/** `6h ago`, and only once the snapshot is old enough to matter. */
function SnapshotAge({ snapshot, nowMs }: { snapshot: AccountLimitsSnapshot; nowMs: number }) {
  const ageMs = nowMs - Date.parse(snapshot.asOf);
  if (!Number.isFinite(ageMs) || ageMs < STALE_AFTER_MS) return null;
  return (
    <span className="text-[10px] text-muted-foreground">{formatAgo(snapshot.asOf, nowMs)}</span>
  );
}

/** Always-visible remaining capacity beside the sidebar's Usage label. */
export function AccountLimitsSidebarGauges() {
  const { snapshots } = useAccountLimits();
  const nowMs = useNowMs();

  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 group-data-[collapsible=icon]:hidden">
      {PROVIDER_ORDER.map((provider) => {
        const snapshot = snapshots.get(provider);
        if (snapshot === undefined || snapshot.windows.length === 0) return null;
        return (
          <AccountLimitsSidebarGauge
            key={provider}
            nowMs={nowMs}
            provider={provider}
            snapshot={snapshot}
          />
        );
      })}
    </span>
  );
}

function AccountLimitsSidebarGauge({
  nowMs,
  provider,
  snapshot,
}: {
  nowMs: number;
  provider: UsageProviderKind;
  snapshot: AccountLimitsSnapshot;
}) {
  const Mark = PROVIDER_MARK[provider];
  const windows = snapshot.windows.slice(0, 2);
  const ariaLabel = `${PROVIDER_LABEL[provider]}: ${windows
    .map(
      (window) =>
        `${compactWindowLabel(window)} ${Math.round(100 - window.usedPercent)} percent remaining`,
    )
    .join(", ")}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={ariaLabel}
            className="relative inline-flex size-7 shrink-0 items-center justify-center"
            role="img"
          />
        }
      >
        <svg aria-hidden="true" className="absolute inset-0 size-7 -rotate-90" viewBox="0 0 32 32">
          {windows.map((window, index) => {
            const radius = index === 0 ? 13.5 : 10;
            const remainingPercent = Math.min(100, Math.max(0, 100 - window.usedPercent));
            return (
              <g key={window.id}>
                <circle
                  className="text-sidebar-border/80"
                  cx="16"
                  cy="16"
                  fill="none"
                  pathLength="100"
                  r={radius}
                  stroke="currentColor"
                  strokeWidth="2"
                />
                {remainingPercent > 0 ? (
                  <circle
                    className={remainingTone(window.usedPercent)}
                    cx="16"
                    cy="16"
                    fill="none"
                    pathLength="100"
                    r={radius}
                    stroke="currentColor"
                    strokeDasharray={`${remainingPercent} ${100 - remainingPercent}`}
                    strokeLinecap="round"
                    strokeWidth="2"
                  />
                ) : null}
              </g>
            );
          })}
        </svg>
        <Mark className="relative size-2.5" />
      </TooltipTrigger>
      <TooltipPopup align="end" className="min-w-44" side="top" sideOffset={6}>
        <div className="flex flex-col gap-1.5 py-1">
          <div className="font-medium text-popover-foreground">{PROVIDER_LABEL[provider]}</div>
          {windows.map((window, index) => (
            <div key={window.id} className="grid grid-cols-[1fr_auto] gap-x-3">
              <span className="text-muted-foreground">
                {index === 0 ? "Outer" : "Inner"} · {compactWindowLabel(window)}
              </span>
              <span className={cn("font-medium tabular-nums", remainingTone(window.usedPercent))}>
                {Math.round(100 - window.usedPercent)}% remaining
              </span>
              <span className="col-span-2 text-[10px] text-muted-foreground/80">
                {formatSidebarResetAt(window.resetsAt, nowMs)}
              </span>
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Sidebar hover card
// ---------------------------------------------------------------------------

/** Compact per-provider availability, shown on hovering the Usage button. */
export function AccountLimitsHoverCard() {
  const { snapshots, isPending, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  if (isPending && snapshots.size === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading limits…</p>;
  }

  return (
    <div className="flex w-64 flex-col gap-2.5 p-1.5">
      {PROVIDER_ORDER.map((provider) => {
        const snapshot = snapshots.get(provider);
        const Mark = PROVIDER_MARK[provider];
        return (
          <div key={provider} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <Mark className="size-3 shrink-0 self-center" />
              <span className="text-xs font-medium text-foreground">
                {PROVIDER_LABEL[provider]}
              </span>
              <span className="ml-auto">
                {snapshot !== undefined ? <SnapshotAge snapshot={snapshot} nowMs={nowMs} /> : null}
              </span>
            </div>
            {snapshot === undefined || snapshot.windows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {snapshot === undefined && isSettling ? "Loading…" : "No limit data yet"}
              </p>
            ) : (
              snapshot.windows.map((window) => (
                <div key={window.id} className="flex items-center gap-2">
                  <span className="w-9 shrink-0 text-[10px] text-muted-foreground">
                    {window.label}
                  </span>
                  <LimitMeter window={window} color={PROVIDER_COLOR[provider]} />
                  <span
                    className={cn(
                      "shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-foreground",
                      usageTone(window.usedPercent),
                    )}
                  >
                    {Math.round(window.usedPercent)}% used
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground">
                    {formatResetAt(window.resetsAt, nowMs) ?? ""}
                  </span>
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage page section
// ---------------------------------------------------------------------------

/** The "Limits" strip above the analytics: one column per provider. */
export function AccountLimitsSection() {
  const { snapshots, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Limits</h2>
      <div className="grid gap-x-12 gap-y-4 sm:grid-cols-2">
        {PROVIDER_ORDER.map((provider) => {
          const snapshot = snapshots.get(provider);
          const Mark = PROVIDER_MARK[provider];
          return (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <Mark className="size-3.5 shrink-0 self-center" />
                <span className="text-sm font-medium text-foreground">
                  {PROVIDER_LABEL[provider]}
                </span>
                <span className="ml-auto">
                  {snapshot !== undefined ? (
                    <SnapshotAge snapshot={snapshot} nowMs={nowMs} />
                  ) : null}
                </span>
              </div>
              {snapshot === undefined || snapshot.windows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {snapshot === undefined && isSettling ? "Loading…" : "No limit data yet"}
                </p>
              ) : (
                snapshot.windows.map((window) => {
                  const resetAt = formatResetAt(window.resetsAt, nowMs);
                  return (
                    <div key={window.id} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-xs text-muted-foreground">
                        {window.label}
                      </span>
                      <LimitMeter window={window} color={PROVIDER_COLOR[provider]} />
                      <span
                        className={cn(
                          "shrink-0 whitespace-nowrap text-right text-xs font-medium tabular-nums text-foreground",
                          usageTone(window.usedPercent),
                        )}
                      >
                        {Math.round(window.usedPercent)}% used
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
                        {resetAt === null ? "" : `resets ${resetAt}`}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
