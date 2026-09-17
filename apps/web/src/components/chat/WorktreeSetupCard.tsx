import {
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  LaptopIcon,
  MinusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

interface WorktreeSetupCardProps {
  snapshot: WorktreeSetupSnapshot;
  /** Interrupts the server-side bootstrap. Hidden once the setup has settled. */
  onCancel: (() => void) | null;
  /** Restarts the same message in the project checkout instead of a worktree. */
  onWorkLocally: (() => void) | null;
  /** Reveals the setup script terminal tab. Null when no script ran. */
  onOpenTerminal: (() => void) | null;
}

function stageElapsedMs(stage: WorktreeSetupStage, nowMs: number): number | null {
  if (!stage.startedAt) return null;
  const start = Date.parse(stage.startedAt);
  const end = stage.endedAt ? Date.parse(stage.endedAt) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Ticks once a second while any stage runs so elapsed labels stay live
 * without pushing a React commit through the timeline for every second.
 */
function useNowWhile(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function StageIcon({ status }: { status: WorktreeSetupStage["status"] }) {
  const className = "size-4 shrink-0 stroke-[1.8]";
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "running":
      return <Spinner className={className} />;
    case "failed":
      return <XIcon aria-hidden className={className} />;
    case "warning":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "skipped":
      return <MinusIcon aria-hidden className={className} />;
    case "pending":
      return <CircleIcon aria-hidden className={className} />;
  }
}

function stageRowClassName(status: WorktreeSetupStage["status"]): string {
  switch (status) {
    case "failed":
      return "text-destructive-foreground";
    case "warning":
      return "text-warning-foreground";
    case "pending":
      return "text-secondary-label opacity-40";
    case "running":
    case "skipped":
    case "done":
      return "text-secondary-label";
  }
}

/** Same shimmer treatment as the live tool rows in the timeline. */
function ShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

function headerLabel(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running":
      return "Setting up worktree…";
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed")
        ? "Worktree ready, setup script failed"
        : "Worktree ready";
    case "failed":
      return "Worktree setup failed";
    case "cancelled":
      return "Worktree setup cancelled";
  }
}

/**
 * Occupies the same slot, with the same metrics, as the "Working for" header
 * so the handoff to the agent's turn only swaps the text.
 */
function SetupHeaderRow({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: number | null;
}) {
  const running = snapshot.phase === "running";
  const failed = snapshot.phase === "failed";
  const finishedWithFailedStage =
    snapshot.phase === "done" && snapshot.stages.some((stage) => stage.status === "failed");
  const text = headerLabel(snapshot);
  const tone = failed
    ? "text-destructive-foreground"
    : finishedWithFailedStage
      ? "text-warning-foreground"
      : "text-muted-foreground";
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <div
        className={cn(
          "flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums",
          tone,
        )}
      >
        <span
          ref={running ? observeVisibleAnimation : undefined}
          className="relative min-w-0 shrink overflow-hidden whitespace-nowrap"
        >
          <span className="block truncate">{text}</span>
          {running ? <ShimmerOverlay>{text}</ShimmerOverlay> : null}
        </span>
        {totalElapsed !== null ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatDuration(totalElapsed)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One stage, rendered like a live work entry row. */
function StageRow({
  stage,
  nowMs,
  scriptName,
}: {
  stage: WorktreeSetupStage;
  nowMs: number;
  scriptName: string | null;
}) {
  const elapsed = stageElapsedMs(stage, nowMs);
  const label =
    stage.id === "setup-script" && scriptName ? scriptName : worktreeSetupStageLabel(stage.id);
  const running = stage.status === "running";
  const trailing =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? "skipped")
        : stage.id === "checkout" && running && stage.percent !== null
          ? `${stage.percent}%`
          : stage.detail;
  return (
    <div
      ref={running ? observeVisibleAnimation : undefined}
      className={cn(
        "relative flex min-h-6 min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-0.5 py-0.5 text-sm leading-relaxed",
        stageRowClassName(stage.status),
      )}
      data-worktree-setup-stage={stage.id}
      data-worktree-setup-status={stage.status}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <StageIcon status={stage.status} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums">
          {trailing}
        </span>
      ) : null}
      {elapsed !== null && stage.status !== "skipped" && stage.status !== "pending" ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(elapsed)}
        </span>
      ) : null}
      {running ? (
        <ShimmerOverlay>
          <span className="flex min-h-6 items-center gap-1.5 px-0.5 py-0.5">
            <span className="flex size-6 shrink-0 items-center justify-center">
              <StageIcon status={stage.status} />
            </span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </span>
        </ShimmerOverlay>
      ) : null}
    </div>
  );
}

/** The server keeps this many trailing lines; the box is sized for exactly that. */
const OUTPUT_TAIL_LINES = 4;
const OUTPUT_TAIL_SLOTS = Array.from({ length: OUTPUT_TAIL_LINES }, (_, slot) => slot);

/**
 * Fixed-height window onto the script's last lines. Rows never wrap and the
 * box never grows or shrinks, so streaming output cannot push the timeline
 * around while the script runs.
 */
function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  const rows = OUTPUT_TAIL_SLOTS.map((slot) => ({
    slot,
    line: lines[lines.length - OUTPUT_TAIL_LINES + slot] ?? "",
  }));
  return (
    <pre
      className={cn(
        "mb-1 ml-8 overflow-hidden rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed select-text",
        failed
          ? "border-destructive/20 bg-error-surface text-destructive-foreground"
          : "border-border bg-code text-muted-foreground",
      )}
    >
      {rows.map(({ slot, line }) => (
        <div key={slot} className="truncate whitespace-pre">
          {line.length === 0 ? "\u00a0" : line}
        </div>
      ))}
    </pre>
  );
}

function SetupDetails({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  return (
    <dl className="mt-1 mb-1.5 ml-8 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
      {snapshot.branch ? (
        <>
          <dt className="text-foreground/80">Branch</dt>
          <dd className="truncate font-mono">{snapshot.branch}</dd>
        </>
      ) : null}
      {snapshot.baseRef ? (
        <>
          <dt className="text-foreground/80">Base</dt>
          <dd className="truncate font-mono">{snapshot.baseRef}</dd>
        </>
      ) : null}
      {snapshot.worktreePath ? (
        <>
          <dt className="text-foreground/80">Path</dt>
          <dd className="truncate font-mono">{snapshot.worktreePath}</dd>
        </>
      ) : null}
      {snapshot.setupScript ? (
        <>
          <dt className="text-foreground/80">Setup</dt>
          <dd className="truncate font-mono">{snapshot.setupScript.command}</dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * One-line summary of a settled setup under a live turn. A clean finish is
 * removed from the timeline altogether, so this only renders the outcomes
 * worth keeping: a failed script, a failed setup, or a cancelled one.
 */
function CollapsedSummaryRow({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: number | null;
}) {
  const status: WorktreeSetupStage["status"] =
    snapshot.phase === "failed" || snapshot.phase === "cancelled"
      ? "failed"
      : snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "failed")
        ? "failed"
        : "done";
  const label = headerLabel(snapshot);
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-sm leading-relaxed",
        stageRowClassName(status),
      )}
      data-worktree-setup-stage="summary"
      data-worktree-setup-status={status}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <StageIcon status={status} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {totalElapsed !== null ? (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(totalElapsed)}
        </span>
      ) : null}
    </div>
  );
}

export function WorktreeSetupCard({
  snapshot,
  onCancel,
  onWorkLocally,
  onOpenTerminal,
  embedded = false,
}: WorktreeSetupCardProps & {
  /**
   * The agent's turn is live and owns the "Working for" header. The stage
   * list stays exactly where it was so the handoff never moves anything; a
   * failed script that outlives the handoff collapses to a single row.
   */
  embedded?: boolean;
}) {
  const running = snapshot.phase === "running";
  const nowMs = useNowWhile(running);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const totalElapsed = (() => {
    const start = Date.parse(snapshot.startedAt);
    const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  })();
  const setupStage = snapshot.stages.find((stage) => stage.id === "setup-script");
  const showTerminal = onOpenTerminal && setupStage && setupStage.status !== "pending";
  const collapsed = embedded && !running;
  // While running, the timeline's working row above the card carries the
  // "Setting up worktree…" label (and keeps that slot when the agent takes
  // over). The card only brings its own header for a settled outcome that
  // has no working row to sit under.
  const showHeader = !embedded && !running;
  // The tail box is part of the script row's footprint while the script runs
  // (and after it failed, so the last lines explain the failure). It mounts
  // as soon as the script is running, empty lines and all, so the card takes
  // its final height once instead of growing with each output line.
  const showTail =
    setupStage !== undefined && (setupStage.status === "running" || setupStage.status === "failed");

  return (
    <section aria-label="Worktree setup" data-worktree-setup-phase={snapshot.phase}>
      {showHeader ? <SetupHeaderRow snapshot={snapshot} totalElapsed={totalElapsed} /> : null}
      {collapsed ? (
        <CollapsedSummaryRow snapshot={snapshot} totalElapsed={totalElapsed} />
      ) : (
        <div className={showHeader ? "pt-1.5" : undefined}>
          {snapshot.stages.map((stage) => (
            <div key={stage.id}>
              <StageRow
                stage={stage}
                nowMs={nowMs}
                scriptName={snapshot.setupScript?.name ?? null}
              />
              {stage.id === "setup-script" && showTail ? (
                <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {snapshot.phase === "failed" && snapshot.error ? (
        <p className="mt-1 ml-8 text-xs text-muted-foreground">{snapshot.error}</p>
      ) : null}

      {detailsOpen ? <SetupDetails snapshot={snapshot} /> : null}

      {/* Indented so the first label lines up with the stage labels: the icon
          column, minus the xs button's own horizontal padding. */}
      <div className="mt-0.5 ml-[calc(--spacing(6)+2px-(--spacing(2)-1px))] flex flex-wrap items-center gap-0.5">
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          {detailsOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          Details
        </Button>
        {showTerminal ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onOpenTerminal}>
            <TerminalIcon aria-hidden />
            Open terminal
          </Button>
        ) : null}
        {onWorkLocally ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onWorkLocally}>
            <LaptopIcon aria-hidden />
            Work locally
          </Button>
        ) : null}
        {onCancel && running ? (
          <Button type="button" size="xs" variant="ghost-muted" onClick={onCancel}>
            <XIcon aria-hidden />
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}
