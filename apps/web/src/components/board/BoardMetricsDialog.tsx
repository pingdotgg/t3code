import type { WorkflowBoardMetrics } from "@t3tools/contracts";
import { BarChart2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { formatDuration } from "~/session-logic";

// ─── Primitives ─────────────────────────────────────────────────────────────

function StatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-card/35 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/** A labelled horizontal bar. `fraction` is 0–1; clamped to [0,1]. */
function BarRow({
  label,
  value,
  fraction,
}: {
  readonly label: string;
  readonly value: number;
  readonly fraction: number;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 font-medium text-foreground">{value}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-border/40">
        <div
          className="h-1.5 rounded-full bg-primary/60 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SectionHeading({ children }: { readonly children: string }) {
  return (
    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

// ─── Window selector ────────────────────────────────────────────────────────

type WindowDays = 1 | 7 | 30;
const WINDOWS: ReadonlyArray<{ label: string; value: WindowDays }> = [
  { label: "24h", value: 1 },
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtMs(ms: number, count: number): string {
  if (count === 0) return "—";
  return formatDuration(ms);
}

function maxOf(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

// ─── Dialog ─────────────────────────────────────────────────────────────────

export function BoardMetricsDialog({
  disabled,
  onFetchMetrics,
  open: controlledOpen,
  onOpenChange,
}: {
  readonly disabled: boolean;
  readonly onFetchMetrics: (windowDays: WindowDays) => Promise<WorkflowBoardMetrics>;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const isControlled = onOpenChange !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? (controlledOpen ?? false) : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) {
      onOpenChange(next);
    } else {
      setUncontrolledOpen(next);
    }
  };
  const [windowDays, setWindowDays] = useState<WindowDays>(7);
  const [metrics, setMetrics] = useState<WorkflowBoardMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = async (days: WindowDays) => {
    const requestId = ++requestRef.current;
    setError(null);
    setMetrics(null);
    try {
      const next = await onFetchMetrics(days);
      if (requestRef.current === requestId) {
        setMetrics(next);
      }
    } catch (cause) {
      if (requestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : "Failed to load metrics.");
      }
    }
  };

  const handleWindowChange = (days: WindowDays) => {
    setWindowDays(days);
    void load(days);
  };

  const windowLabel: string =
    WINDOWS.find((w) => w.value === windowDays)?.label ?? `${String(windowDays)}d`;

  const hasAnyData =
    metrics !== null &&
    (metrics.throughput.created > 0 ||
      metrics.throughput.shipped > 0 ||
      metrics.cycleTime.count > 0 ||
      metrics.wipByLane.some((l) => l.admitted > 0 || l.queued > 0) ||
      Object.keys(metrics.statusBreakdown).length > 0 ||
      metrics.attention.blocked > 0 ||
      metrics.attention.waitingOnUser > 0 ||
      metrics.attention.oldest.length > 0 ||
      metrics.routeOutcomes.length > 0 ||
      metrics.manualMoveCount > 0 ||
      metrics.stepStats.length > 0);

  // In controlled mode the parent owns the trigger, so the load the
  // self-contained trigger's onClick performed (with the current windowDays)
  // must fire when the dialog transitions to open.
  useEffect(() => {
    if (isControlled && open && metrics === null && error === null) {
      void load(windowDays);
    }
  }, [isControlled, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          requestRef.current += 1;
          setMetrics(null);
        }
      }}
    >
      {isControlled ? null : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          title="Board metrics and throughput charts"
          onClick={() => {
            setOpen(true);
            void load(windowDays);
          }}
        >
          <BarChart2Icon className="size-3.5" />
          Insights
        </Button>
      )}
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-hidden">
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Board insights</DialogTitle>
            <DialogDescription>
              Current state and windowed activity data for this board.
            </DialogDescription>
          </DialogHeader>

          {/* Window selector — applies to windowed sections only */}
          <div className="flex shrink-0 items-center gap-2 px-6 pb-2">
            <span className="text-xs text-muted-foreground">Window:</span>
            {WINDOWS.map(({ label, value }) => (
              <Button
                key={value}
                type="button"
                size="xs"
                variant={windowDays === value ? "secondary" : "ghost"}
                onClick={() => handleWindowChange(value)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div
            className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pt-1 pb-4"
            data-testid="board-metrics"
          >
            {error !== null ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : metrics === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !hasAnyData ? (
              <p className="text-sm text-muted-foreground">No data for this board.</p>
            ) : (
              <>
                {/* ── Throughput ── */}
                <section>
                  <SectionHeading>{`Throughput (last ${windowLabel})`}</SectionHeading>
                  <dl className="grid grid-cols-2 gap-3">
                    <StatCard label="Created" value={String(metrics.throughput.created)} />
                    <StatCard label="Shipped" value={String(metrics.throughput.shipped)} />
                    <StatCard label="Manual moves" value={String(metrics.manualMoveCount)} />
                  </dl>
                </section>

                {/* ── Cycle time ── */}
                <section>
                  <SectionHeading>{`Cycle time (last ${windowLabel})`}</SectionHeading>
                  <dl className="grid grid-cols-3 gap-3">
                    <StatCard
                      label="p50"
                      value={fmtMs(metrics.cycleTime.p50Ms, metrics.cycleTime.count)}
                    />
                    <StatCard
                      label="p90"
                      value={fmtMs(metrics.cycleTime.p90Ms, metrics.cycleTime.count)}
                    />
                    <StatCard
                      label="avg"
                      value={fmtMs(metrics.cycleTime.avgMs, metrics.cycleTime.count)}
                    />
                  </dl>
                </section>

                {/* ── Attention ── */}
                <section>
                  <SectionHeading>Attention needed (current)</SectionHeading>
                  <dl className="grid grid-cols-2 gap-3">
                    <StatCard label="Blocked" value={String(metrics.attention.blocked)} />
                    <StatCard
                      label="Waiting on you"
                      value={String(metrics.attention.waitingOnUser)}
                    />
                  </dl>
                  {metrics.attention.oldest.length > 0 ? (
                    <ol className="mt-3 space-y-1.5">
                      {metrics.attention.oldest.map((ticket) => (
                        <li
                          key={ticket.ticketId}
                          className="flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5"
                        >
                          <span className="min-w-0 truncate text-sm text-foreground">
                            {ticket.title}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {ticket.laneKey ?? "—"} · {formatDuration(ticket.ageMs)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </section>

                {/* ── WIP by lane ── */}
                {metrics.wipByLane.length > 0 ? (
                  <section>
                    <SectionHeading>Current WIP by lane</SectionHeading>
                    <div className="space-y-3">
                      {(() => {
                        const wipMax = maxOf(
                          metrics.wipByLane.flatMap((l) => [l.admitted, l.queued]),
                        );
                        return metrics.wipByLane.map((lane) => (
                          <div key={lane.laneKey} className="space-y-1.5">
                            <BarRow
                              label={`${lane.laneKey} — admitted`}
                              value={lane.admitted}
                              fraction={wipMax > 0 ? lane.admitted / wipMax : 0}
                            />
                            <BarRow
                              label={`${lane.laneKey} — queued`}
                              value={lane.queued}
                              fraction={wipMax > 0 ? lane.queued / wipMax : 0}
                            />
                          </div>
                        ));
                      })()}
                    </div>
                  </section>
                ) : null}

                {/* ── Status breakdown ── */}
                {Object.keys(metrics.statusBreakdown).length > 0 ? (
                  <section>
                    <SectionHeading>Status breakdown (current)</SectionHeading>
                    <div className="space-y-2">
                      {(() => {
                        const entries = Object.entries(metrics.statusBreakdown);
                        const maxCount = maxOf(entries.map(([, v]) => v));
                        return entries.map(([status, count]) => (
                          <BarRow
                            key={status}
                            label={status}
                            value={count}
                            fraction={maxCount > 0 ? count / maxCount : 0}
                          />
                        ));
                      })()}
                    </div>
                  </section>
                ) : null}

                {/* ── Route outcomes ── */}
                {metrics.routeOutcomes.length > 0 ? (
                  <section>
                    <SectionHeading>{`Route outcomes (last ${windowLabel})`}</SectionHeading>
                    <div className="space-y-2">
                      {(() => {
                        const maxCount = maxOf(metrics.routeOutcomes.map((r) => r.count));
                        return metrics.routeOutcomes.map((r, i) => {
                          const from = r.fromLane ?? "—";
                          const to = r.toLane ?? "—";
                          const resultSuffix = r.result === "n/a" ? "" : ` (${r.result})`;
                          return (
                            <BarRow
                              key={i}
                              label={`${r.source}: ${from} → ${to}${resultSuffix}`}
                              value={r.count}
                              fraction={maxCount > 0 ? r.count / maxCount : 0}
                            />
                          );
                        });
                      })()}
                    </div>
                  </section>
                ) : null}

                {/* ── Step stats ── */}
                {metrics.stepStats.length > 0 ? (
                  <section>
                    <SectionHeading>{`Step stats (last ${windowLabel})`}</SectionHeading>
                    <div className="space-y-3">
                      {(() => {
                        const maxSucceeded = maxOf(metrics.stepStats.map((s) => s.succeeded));
                        return metrics.stepStats.map((step, i) => (
                          <div
                            key={i}
                            className="rounded-md border border-border/60 bg-card/20 p-2.5"
                          >
                            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                              <span className="font-medium text-foreground">
                                {step.laneKey}/{step.stepKey}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                {step.stepType}
                              </span>
                            </div>
                            <BarRow
                              label={`ok ${step.succeeded} / fail ${step.failed} / retry ${step.retries}`}
                              value={step.succeeded}
                              fraction={maxSucceeded > 0 ? step.succeeded / maxSucceeded : 0}
                            />
                            {step.avgDurationMs > 0 ? (
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                avg {formatDuration(step.avgDurationMs)}
                              </p>
                            ) : null}
                          </div>
                        ));
                      })()}
                    </div>
                  </section>
                ) : null}
              </>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
