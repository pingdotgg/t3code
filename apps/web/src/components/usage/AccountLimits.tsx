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
import type { AccountLimitsSnapshot, AccountLimitsWindow } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useAccountLimits } from "../../state/accountLimits";
import { formatAgo, formatResetAt } from "../../usage/limitsFormat";
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
