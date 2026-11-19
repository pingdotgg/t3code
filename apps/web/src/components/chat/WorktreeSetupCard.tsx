import { worktreeSetupStageLabel } from "@t3tools/client-runtime/contract-labels";
import type { WorktreeSetupSnapshot, WorktreeSetupStage } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { msg, T, useGT, useMessages, Var } from "gt-react";
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
import type { MessageResolver } from "~/i18n/messages";
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
  const m = useMessages();
  const elapsed = elapsedMs(startedAt, useNowSecond());
  return elapsed === null ? null : <>{formatDuration(elapsed, m)}</>;
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
  const m = useMessages();
  if (!startedAt) return null;
  if (endedAt) {
    const elapsed = elapsedMs(startedAt, Date.parse(endedAt));
    return elapsed === null ? null : <>{formatDuration(elapsed, m)}</>;
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

function headerLabel(snapshot: WorktreeSetupSnapshot, resolve: MessageResolver): string {
  switch (snapshot.phase) {
    case "running":
      return resolve(msg("Setting up worktree…"));
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed")
        ? resolve(msg("Worktree ready, setup script failed"))
        : resolve(msg("Worktree ready"));
    case "failed":
      return resolve(msg("Worktree setup failed"));
    case "cancelled":
      return resolve(msg("Worktree setup cancelled"));
  }
}

function HeaderIcon({ snapshot }: { snapshot: WorktreeSetupSnapshot }) {
  switch (snapshot.phase) {
    case "running":
      return (
        <span className="inline-flex shrink-0 text-info-foreground">
          <Spinner size="sm" />
        </span>
      );
    case "done":
      return snapshot.stages.some((stage) => stage.status === "failed") ? (
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
      ) : (
        <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success-foreground" />
      );
    case "failed":
      return <CircleXIcon aria-hidden className="size-3.5 shrink-0 text-error-foreground" />;
    case "cancelled":
      return <MinusIcon aria-hidden className="size-3.5 shrink-0 text-dim-foreground" />;
  }
}

/** The stage in progress, such as "Checking out 45%", shown beside the running header. */
function runningStageLabel(
  snapshot: WorktreeSetupSnapshot,
  resolve: MessageResolver,
): string | null {
  if (snapshot.phase !== "running") return null;
  const stage = snapshot.stages.find((entry) => entry.status === "running");
  if (!stage || stage.id === "setup-script") return null;
  const label = worktreeSetupStageLabel(stage.id, resolve);
  return stage.percent !== null ? `${label} ${stage.percent}%` : label;
}

function CardHeader({
  snapshot,
  totalElapsed,
}: {
  snapshot: WorktreeSetupSnapshot;
  totalElapsed: ReactNode;
}) {
  const m = useMessages();
  const running = snapshot.phase === "running";
  const text = headerLabel(snapshot, m);
  const stageLabel = runningStageLabel(snapshot, m);
  return (
    <div className="flex min-w-0 items-center gap-2 px-3.5 py-2.5 text-label tabular-nums">
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
          {running ? (
            <T>
              Working for <Var>{totalElapsed}</Var>
            </T>
          ) : (
            <T>
              took <Var>{totalElapsed}</Var>
            </T>
          )}
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
  label: ReactNode;
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-meta">
      <dt
        className={cn(
          "w-14 shrink-0 text-dim-foreground",
          trailing ? "flex h-6 items-center self-start" : null,
        )}
      >
        {label}
      </dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="flex min-w-40 flex-1 items-center gap-2.5">
          <span aria-hidden className="shrink-0 text-muted-foreground [&>svg]:size-3">
            {icon}
          </span>
          <span className="min-w-0 flex-1 font-mono text-foreground">{children}</span>
        </span>
        {trailing}
      </dd>
    </div>
  );
}

/** "exit 1" for a script that exited non-zero, from the tracker's "exited with 1" detail. */
function setupStatusChip(stage: WorktreeSetupStage): ReactNode {
  switch (stage.status) {
    case "running":
      return (
        <Badge variant="info">
          <T context="worktree setup stage status">running</T>
        </Badge>
      );
    case "done":
      return (
        <Badge variant="success">
          <T context="worktree setup stage status">done</T>
        </Badge>
      );
    case "failed": {
      const exitCode = stage.detail?.match(/exited with (\d+)/)?.[1];
      return (
        <Badge variant="error">
          {exitCode ? (
            <T context="worktree setup stage status">
              exit <Var>{exitCode}</Var>
            </T>
          ) : (
            <T context="worktree setup stage status">failed</T>
          )}
        </Badge>
      );
    }
    case "warning":
      return (
        <Badge variant="warning">
          <T context="worktree setup stage status">warning</T>
        </Badge>
      );
    case "skipped":
      return (
        <Badge variant="secondary">
          <T context="worktree setup stage status">skipped</T>
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="unavailable">
          <T context="worktree setup stage status">pending</T>
        </Badge>
      );
  }
}

const OUTPUT_TAIL_LINES = 4;
const OUTPUT_TAIL_SLOTS = Array.from({ length: OUTPUT_TAIL_LINES }, (_, slot) => slot);
const FAILURE_LINE = /\b(error|failed|failure|fatal|panic|exception)\b/i;

function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  const rows = OUTPUT_TAIL_SLOTS.map((slot) => ({
    slot,
    line: lines[lines.length - OUTPUT_TAIL_LINES + slot] ?? "",
  }));
  return (
    <pre className="flex flex-col gap-0.5 overflow-hidden rounded-lg bg-well px-2.5 py-2 dark:bg-black/35 dark:bg-none font-mono text-caption text-muted-foreground select-text">
      {rows.map(({ slot, line }) => (
        <div
          key={slot}
          className={cn(
            "truncate whitespace-pre",
            failed && FAILURE_LINE.test(line) && "text-error-foreground",
          )}
        >
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
  const m = useMessages();
  const status: WorktreeSetupStage["status"] =
    snapshot.phase === "failed" || snapshot.phase === "cancelled"
      ? "failed"
      : snapshot.stages.some((stage) => stage.id === "setup-script" && stage.status === "failed")
        ? "failed"
        : "done";
  const label = headerLabel(snapshot, m);
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
  const gt = useGT();
  const m = useMessages();
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
      <T>Retry</T>
    </Button>
  ) : null;

  if (collapsed) {
    return (
      <section aria-label={gt("Worktree setup")} data-worktree-setup-phase={snapshot.phase}>
        <CollapsedSummaryRow
          snapshot={snapshot}
          totalElapsed={totalElapsed}
          trailing={
            <>
              {showTerminal ? (
                <Button type="button" size="xs" variant="ghost-muted" onClick={onOpenTerminal}>
                  <TerminalIcon aria-hidden />
                  <T>Open terminal</T>
                </Button>
              ) : null}
              {retryButton}
            </>
          }
        />
      </section>
    );
  }

  const showSetupRow = setupStage !== undefined && setupStage.status !== "skipped";
  const hasActions = showTerminal || onWorkLocally || (onCancel && running);
  const actions = hasActions ? (
    <>
      {showTerminal ? (
        <Button type="button" size="xs" variant="secondary" onClick={onOpenTerminal}>
          <TerminalIcon aria-hidden />
          <T>Open terminal</T>
        </Button>
      ) : null}
      {onWorkLocally ? (
        <Button type="button" size="xs" variant="secondary" onClick={onWorkLocally}>
          <LaptopIcon aria-hidden />
          <T>Work locally</T>
        </Button>
      ) : null}
      {onCancel && running ? (
        <Button type="button" size="xs" variant="secondary" onClick={onCancel}>
          <XIcon aria-hidden />
          <T>Cancel</T>
        </Button>
      ) : null}
    </>
  ) : null;
  return (
    <section
      aria-label={gt("Worktree setup")}
      data-worktree-setup-phase={snapshot.phase}
      className={cn("overflow-hidden rounded-card", embedded ? "surface-card" : "surface-panel")}
    >
      <CardHeader snapshot={snapshot} totalElapsed={totalElapsed} />
      <div className="flex flex-col gap-1.5 px-3.5 pt-2.5 pb-3">
        <dl className="flex flex-col gap-1.5">
          {snapshot.baseRef ? (
            <DetailRow label={<T context="git base branch">Base</T>} icon={<GitBranchIcon />}>
              <MiddleTruncate value={snapshot.baseRef} className="flex" />
            </DetailRow>
          ) : null}
          {snapshot.branch ? (
            <DetailRow label={<T>Branch</T>} icon={<GitBranchPlusIcon />}>
              <MiddleTruncate value={snapshot.branch} className="flex" />
            </DetailRow>
          ) : null}
          {snapshot.worktreePath ? (
            <DetailRow label={<T>Path</T>} icon={<FolderIcon />}>
              <MiddleTruncate value={snapshot.worktreePath} className="flex" />
            </DetailRow>
          ) : null}
          {setupStage && showSetupRow ? (
            <div className="mt-1">
              <DetailRow
                label={<T context="setup script">Setup</T>}
                icon={<PlayIcon />}
                trailing={
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {setupStatusChip(setupStage)}
                    {retryButton}
                    {actions}
                  </span>
                }
              >
                <span className="block truncate">
                  {snapshot.setupScript?.command ??
                    snapshot.setupScript?.name ??
                    gt("Setup script")}
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
            {failedStage
              ? gt("{stage} failed", { stage: worktreeSetupStageLabel(failedStage.id, m) })
              : null}
            {failedStage && (snapshot.error ?? failedStage.detail) ? ": " : null}
            {snapshot.error ?? failedStage?.detail}
          </p>
        ) : null}

        {actions && !showSetupRow ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
        ) : null}
      </div>
    </section>
  );
}
