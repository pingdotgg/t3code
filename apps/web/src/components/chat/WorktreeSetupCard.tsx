import {
  worktreeSetupStageLabel,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  GitBranchPlusIcon,
  LaptopIcon,
  MinusIcon,
  PlayIcon,
  RotateCcwIcon,
  TerminalIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { MiddleTruncate } from "../ui/middle-truncate";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import { useNowSecond } from "~/hooks/useNowSecond";
import { WorkLogRow } from "./WorkLog";

interface WorktreeSetupCardProps {
  snapshot: WorktreeSetupSnapshot;
  onCancel: (() => void) | null;
  onWorkLocally: (() => void) | null;
  onOpenTerminal: (() => void) | null;
  /** Runs a failed setup script again. Absent or null when a rerun is not possible. */
  onRetry?: (() => void) | null;
}

function elapsedMs(startedAt: string | null, endMs: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - start);
}

/** Mounted only while setup runs, so finished setups never subscribe to the tick. */
function LiveElapsed({ startedAt }: { startedAt: string }) {
  const elapsed = elapsedMs(startedAt, useNowSecond());
  return elapsed === null ? null : <>{formatDuration(elapsed)}</>;
}

/** A finished duration, or a ticking one while setup is still running. */
function Elapsed({
  startedAt,
  endedAt,
  live,
}: {
  startedAt: string | null;
  endedAt: string | null;
  live: boolean;
}) {
  if (!startedAt) return null;
  if (endedAt) {
    const elapsed = elapsedMs(startedAt, Date.parse(endedAt));
    return elapsed === null ? null : <>{formatDuration(elapsed)}</>;
  }
  return live ? <LiveElapsed startedAt={startedAt} /> : null;
}

function StageIcon({ status }: { status: WorktreeSetupStage["status"] }) {
  const className = "size-4 shrink-0 stroke-2";
  switch (status) {
    case "done":
      return <CheckIcon aria-hidden className={className} />;
    case "running":
      return <Spinner size="md" className="shrink-0" />;
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
      return "text-error-foreground";
    case "warning":
      return "text-warning-foreground";
    case "pending":
      return "text-dim-foreground";
    case "running":
    case "skipped":
    case "done":
      return "text-foreground";
  }
}

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

function HeaderIcon({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  switch (snapshot.phase) {
    case "running":
      return (
        <span className="inline-flex shrink-0 text-info-foreground">
          <Spinner size="md" />
        </span>
      );
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed") ? (
        <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />
      ) : (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-success-foreground" />
      );
    case "failed":
      return <CircleXIcon aria-hidden className="size-4 shrink-0 text-error-foreground" />;
    case "cancelled":
      return <MinusIcon aria-hidden className="size-4 shrink-0 text-dim-foreground" />;
  }
}

/** The stage in progress, such as "Checking out 45%", shown beside the running header. */
function runningStageLabel(snapshot: WorktreeSetupSnapshot): string | null {
  if (snapshot.phase !== "running") return null;
  const stage = snapshot.stages.find((entry) => entry.status === "running");
  if (!stage || stage.id === "setup-script") return null;
  const label = worktreeSetupStageLabel(stage.id);
  return stage.percent !== null ? `${label} ${stage.percent}%` : label;
}

function CardHeader({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: ReactNode;
}) {
  const running = snapshot.phase === "running";
  const text = headerLabel(snapshot);
  const stageLabel = runningStageLabel(snapshot);
  return (
    <div className="flex h-10 min-w-0 items-center gap-2.5 border-b border-hairline px-3.5 text-body tabular-nums">
      <HeaderIcon snapshot={snapshot} />
      <span
        ref={running ? observeVisibleAnimation : undefined}
        className="relative min-w-0 shrink overflow-hidden whitespace-nowrap font-medium text-strong-foreground"
      >
        <span className="block truncate">{text}</span>
        {running ? <ShimmerOverlay>{text}</ShimmerOverlay> : null}
      </span>
      {stageLabel ? (
        <span className="min-w-0 truncate text-meta text-dim-foreground">{stageLabel}</span>
      ) : null}
      {totalElapsed !== null ? (
        <span className="ml-auto shrink-0 text-meta text-dim-foreground">
          {running ? "Working for " : "took "}
          {totalElapsed}
        </span>
      ) : null}
    </div>
  );
}

function DetailRow({
  label,
  icon,
  children,
  trailing,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-3 text-body">
      <dt className="w-14 shrink-0 text-dim-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2.5">
        <span aria-hidden className="shrink-0 text-muted-foreground [&>svg]:size-3.5">
          {icon}
        </span>
        <span className="min-w-0 flex-1 font-mono text-foreground">{children}</span>
        {trailing}
      </dd>
    </div>
  );
}

/** "exit 1" for a script that exited non-zero, from the tracker's "exited with 1" detail. */
function setupStatusChip(stage: WorktreeSetupStage): ReactNode {
  switch (stage.status) {
    case "running":
      return <Badge variant="info">running</Badge>;
    case "done":
      return <Badge variant="success">done</Badge>;
    case "failed": {
      const exitCode = stage.detail?.match(/exited with (\d+)/)?.[1];
      return <Badge variant="error">{exitCode ? `exit ${exitCode}` : "failed"}</Badge>;
    }
    case "warning":
      return <Badge variant="warning">warning</Badge>;
    case "skipped":
      return <Badge variant="secondary">skipped</Badge>;
    case "pending":
      return <Badge variant="unavailable">pending</Badge>;
  }
}

const OUTPUT_TAIL_LINES = 4;
const OUTPUT_TAIL_SLOTS = Array.from({ length: OUTPUT_TAIL_LINES }, (_, slot) => slot);

function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  const rows = OUTPUT_TAIL_SLOTS.map((slot) => ({
    slot,
    line: lines[lines.length - OUTPUT_TAIL_LINES + slot] ?? "",
  }));
  return (
    <pre
      className={cn(
        "overflow-hidden rounded-control surface-well px-2.5 py-1.5 font-mono text-caption leading-relaxed select-text",
        failed ? "text-error-foreground" : "text-muted-foreground",
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

function CollapsedSummaryRow({
  snapshot,
  totalElapsed,
  trailing,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: ReactNode;
  trailing: ReactNode;
}) {
  const status: WorktreeSetupStage["status"] =
    snapshot.phase === "failed" || snapshot.phase === "cancelled"
      ? "failed"
      : snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "failed")
        ? "failed"
        : "done";
  const label = headerLabel(snapshot);
  return (
    <WorkLogRow
      data-worktree-setup-stage="summary"
      data-worktree-setup-status={status}
      icon={
        <span className="text-icon-muted">
          <StageIcon status={status} />
        </span>
      }
      label={<span className={stageRowClassName(status)}>{label}</span>}
      trailing={
        <>
          {totalElapsed !== null ? (
            <span className="shrink-0 text-meta text-dim-foreground tabular-nums">
              {totalElapsed}
            </span>
          ) : null}
          {trailing}
        </>
      }
    />
  );
}

export function WorktreeSetupCard({
  snapshot,
  onCancel,
  onWorkLocally,
  onOpenTerminal,
  onRetry = null,
  embedded = false,
}: WorktreeSetupCardProps & {
  /**
   * The agent's turn is live and owns the "Working for" header. A settled setup that outlives
   * the handoff (a failed script) collapses to a single row; a script still running shows the
   * card in the working header's popover.
   */
  embedded?: boolean;
}) {
  const running = snapshot.phase === "running";
  const totalElapsed = (
    <Elapsed startedAt={snapshot.startedAt} endedAt={snapshot.endedAt} live={running} />
  );
  const setupStage = snapshot.stages.find((stage) => stage.id === "setup-script");
  const showTerminal = onOpenTerminal && setupStage && setupStage.status !== "pending";
  const collapsed = embedded && !running;
  const canRetry = onRetry !== null && !running && setupStage?.status === "failed";
  // The tail box mounts with the script's first output line at its full fixed height, so the
  // card grows once instead of with each line, and a script that ends before printing anything
  // never flashes an empty box. A failed script keeps it so the last lines explain the failure.
  const showTail =
    setupStage !== undefined &&
    (setupStage.status === "failed" ||
      (setupStage.status === "running" && setupStage.tail.length > 0));
  const failedStage =
    snapshot.phase === "failed"
      ? snapshot.stages.find((stage) => stage.status === "failed")
      : undefined;
  const retryButton = canRetry ? (
    <Button type="button" size="xs" variant="secondary" onClick={onRetry}>
      <RotateCcwIcon aria-hidden />
      Retry
    </Button>
  ) : null;

  if (collapsed) {
    return (
      <section aria-label="Worktree setup" data-worktree-setup-phase={snapshot.phase}>
        <CollapsedSummaryRow
          snapshot={snapshot}
          totalElapsed={totalElapsed}
          trailing={retryButton}
        />
      </section>
    );
  }

  const hasActions = showTerminal || onWorkLocally || (onCancel && running);
  return (
    <section
      aria-label="Worktree setup"
      data-worktree-setup-phase={snapshot.phase}
      className="overflow-hidden rounded-card surface-card"
    >
      <CardHeader snapshot={snapshot} totalElapsed={totalElapsed} />
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <dl className="flex flex-col gap-0.5">
          {snapshot.baseRef ? (
            <DetailRow label="Base" icon={<GitBranchIcon />}>
              <MiddleTruncate value={snapshot.baseRef} className="flex" />
            </DetailRow>
          ) : null}
          {snapshot.branch ? (
            <DetailRow label="Branch" icon={<GitBranchPlusIcon />}>
              <MiddleTruncate value={snapshot.branch} className="flex" />
            </DetailRow>
          ) : null}
          {snapshot.worktreePath ? (
            <DetailRow label="Path" icon={<FolderIcon />}>
              <MiddleTruncate value={snapshot.worktreePath} className="flex" />
            </DetailRow>
          ) : null}
          {setupStage && setupStage.status !== "skipped" ? (
            <div className="mt-1.5">
              <DetailRow
                label="Setup"
                icon={<PlayIcon />}
                trailing={
                  <span className="flex shrink-0 items-center gap-2">
                    {setupStatusChip(setupStage)}
                    {retryButton}
                  </span>
                }
              >
                <span className="block truncate">
                  {snapshot.setupScript?.command ?? snapshot.setupScript?.name ?? "Setup script"}
                </span>
              </DetailRow>
            </div>
          ) : null}
        </dl>

        {setupStage && showTail ? (
          <OutputTail lines={setupStage.tail} failed={setupStage.status === "failed"} />
        ) : null}

        {snapshot.phase === "failed" && (snapshot.error || failedStage) ? (
          <p className="text-meta text-error-foreground">
            {failedStage ? `${worktreeSetupStageLabel(failedStage.id)} failed` : null}
            {failedStage && (snapshot.error ?? failedStage.detail) ? ": " : null}
            {snapshot.error ?? failedStage?.detail}
          </p>
        ) : null}

        {hasActions ? (
          <div className="-mx-2 flex flex-wrap items-center gap-0.5">
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
        ) : null}
      </div>
    </section>
  );
}
