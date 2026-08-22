/**
 * Account rate-limit views: the sidebar hover card and the usage page's
 * "Limits" strip. Both render whatever windows the server reports, so a
 * window a provider adds or brings back (Codex's paused 5-hour) appears
 * without a client change.
 *
 * One block per provider; one row group per (environment, instance) under
 * it. With a single row - the common case - nothing is captioned and the
 * markup is identical to the single-account rendering. With several, each
 * group is captioned with the instance's display name (and the environment
 * label when more than one environment reports) so two accounts' numbers
 * can never be mistaken for one another.
 *
 * Every percentage is labelled `used` inline - a bare number cannot say
 * whether it is used or remaining. Snapshot age only renders once the data
 * is actually stale; fresh data needs no caption.
 *
 * @module AccountLimits
 */
import type { AccountLimitsSnapshot, AccountLimitsWindow } from "@t3tools/contracts";
import { formatAgo, formatResetAt } from "@t3tools/shared/limitsFormat";
import { useEffect, useState } from "react";

import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";
import { cn } from "../../lib/utils";
import {
  type AccountLimitsRow,
  legacyInstanceIdFor,
  useAccountLimits,
} from "../../state/accountLimits";
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

/** Stable key for one (environment, instance) row group. */
function rowKey(row: AccountLimitsRow): string {
  // The merge folds unkeyed snapshots onto the driver's default instance
  // id, so the key must share the merge's own mapping.
  const instanceId = row.snapshot.instanceId ?? legacyInstanceIdFor(row.snapshot.provider);
  return `${row.environmentId}:${instanceId}`;
}

/**
 * "Work · laptop" - who a row group belongs to, shown only when a provider
 * has more than one group and the numbers could otherwise be conflated.
 */
function RowCaption({
  row,
  nameEnvironment,
  nowMs,
  className,
}: {
  row: AccountLimitsRow;
  nameEnvironment: boolean;
  nowMs: number;
  className: string;
}) {
  return (
    <div className={cn("flex items-baseline gap-1.5", className)}>
      <span className="truncate">
        {row.instanceLabel}
        {/* The shared option-label contract: blank labels normalize, and
            the primary environment reads "This device" here exactly as it
            does in the pickers. */}
        {nameEnvironment
          ? ` · ${resolveEnvironmentOptionLabel({
              isPrimary: row.environmentIsPrimary,
              environmentId: row.environmentId,
              runtimeLabel: row.environmentLabel,
            })}`
          : ""}
      </span>
      <span className="ml-auto shrink-0">
        <SnapshotAge snapshot={row.snapshot} nowMs={nowMs} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar hover card
// ---------------------------------------------------------------------------

function HoverWindowRow({
  window,
  color,
  nowMs,
}: {
  window: AccountLimitsWindow;
  color: string;
  nowMs: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-9 shrink-0 truncate whitespace-nowrap text-[10px] text-muted-foreground"
        title={window.label}
      >
        {window.label}
      </span>
      <LimitMeter window={window} color={color} />
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
  );
}

/** Compact per-provider availability, shown on hovering the Usage button. */
export function AccountLimitsHoverCard() {
  const { byProvider, reportingEnvironments, isPending, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  if (isPending && byProvider.size === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading limits…</p>;
  }

  return (
    <div className="flex w-64 flex-col gap-2.5 p-1.5">
      {PROVIDER_ORDER.map((provider) => {
        const rows = byProvider.get(provider) ?? [];
        const only = rows.length === 1 ? rows[0] : undefined;
        const Mark = PROVIDER_MARK[provider];
        return (
          <div key={provider} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <Mark className="size-3 shrink-0 self-center" />
              <span className="text-xs font-medium text-foreground">
                {PROVIDER_LABEL[provider]}
              </span>
              <span className="ml-auto">
                {only !== undefined ? <SnapshotAge snapshot={only.snapshot} nowMs={nowMs} /> : null}
              </span>
            </div>
            {rows.length === 0 || (only !== undefined && only.snapshot.windows.length === 0) ? (
              <p className="text-[11px] text-muted-foreground">
                {rows.length === 0 && isSettling ? "Loading…" : "No limit data yet"}
              </p>
            ) : only !== undefined ? (
              // Single group - the common case: same markup as one account.
              only.snapshot.windows.map((window) => (
                <HoverWindowRow
                  key={window.id}
                  window={window}
                  color={PROVIDER_COLOR[provider]}
                  nowMs={nowMs}
                />
              ))
            ) : (
              rows.map((row) => (
                <div key={rowKey(row)} className="flex flex-col gap-1">
                  <RowCaption
                    row={row}
                    nameEnvironment={reportingEnvironments > 1}
                    nowMs={nowMs}
                    className="text-[10px] text-muted-foreground"
                  />
                  {row.snapshot.windows.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No limit data yet</p>
                  ) : (
                    row.snapshot.windows.map((window) => (
                      <HoverWindowRow
                        key={window.id}
                        window={window}
                        color={PROVIDER_COLOR[provider]}
                        nowMs={nowMs}
                      />
                    ))
                  )}
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

function SectionWindowRow({
  window,
  color,
  nowMs,
}: {
  window: AccountLimitsWindow;
  color: string;
  nowMs: number;
}) {
  const resetAt = formatResetAt(window.resetsAt, nowMs);
  return (
    <div className="flex items-center gap-3">
      <span
        className="w-10 shrink-0 truncate whitespace-nowrap text-xs text-muted-foreground"
        title={window.label}
      >
        {window.label}
      </span>
      <LimitMeter window={window} color={color} />
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
}

/** The "Limits" strip above the analytics: one column per provider. */
export function AccountLimitsSection() {
  const { byProvider, reportingEnvironments, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Limits</h2>
      <div className="grid gap-x-12 gap-y-4 sm:grid-cols-2">
        {PROVIDER_ORDER.map((provider) => {
          const rows = byProvider.get(provider) ?? [];
          const only = rows.length === 1 ? rows[0] : undefined;
          const Mark = PROVIDER_MARK[provider];
          return (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <Mark className="size-3.5 shrink-0 self-center" />
                <span className="text-sm font-medium text-foreground">
                  {PROVIDER_LABEL[provider]}
                </span>
                <span className="ml-auto">
                  {only !== undefined ? (
                    <SnapshotAge snapshot={only.snapshot} nowMs={nowMs} />
                  ) : null}
                </span>
              </div>
              {rows.length === 0 || (only !== undefined && only.snapshot.windows.length === 0) ? (
                <p className="text-xs text-muted-foreground">
                  {rows.length === 0 && isSettling ? "Loading…" : "No limit data yet"}
                </p>
              ) : only !== undefined ? (
                // Single group - the common case: same markup as one account.
                only.snapshot.windows.map((window) => (
                  <SectionWindowRow
                    key={window.id}
                    window={window}
                    color={PROVIDER_COLOR[provider]}
                    nowMs={nowMs}
                  />
                ))
              ) : (
                rows.map((row) => (
                  <div key={rowKey(row)} className="flex flex-col gap-1.5">
                    <RowCaption
                      row={row}
                      nameEnvironment={reportingEnvironments > 1}
                      nowMs={nowMs}
                      className="text-xs text-muted-foreground"
                    />
                    {row.snapshot.windows.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No limit data yet</p>
                    ) : (
                      row.snapshot.windows.map((window) => (
                        <SectionWindowRow
                          key={window.id}
                          window={window}
                          color={PROVIDER_COLOR[provider]}
                          nowMs={nowMs}
                        />
                      ))
                    )}
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
