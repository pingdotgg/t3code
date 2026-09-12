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
  GitBranchIcon,
  LaptopIcon,
  MinusIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
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
    case "running":
      return "text-foreground";
    case "failed":
      return "text-destructive-foreground";
    case "warning":
      return "text-warning-foreground";
    case "pending":
    case "skipped":
      return "text-secondary-label opacity-50";
    case "done":
      return "text-secondary-label";
  }
}

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
  const showBar = stage.id === "checkout" && stage.status === "running" && stage.percent !== null;
  const trailing =
    stage.status === "pending"
      ? null
      : stage.status === "skipped"
        ? (stage.detail ?? "skipped")
        : stage.detail;

  return (
    <div
      className={cn(
        "flex min-h-6 items-center gap-1.5 px-0.5 py-0.5 text-sm leading-relaxed",
        stageRowClassName(stage.status),
      )}
      data-worktree-setup-stage={stage.id}
      data-worktree-setup-status={stage.status}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        <StageIcon status={stage.status} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {showBar ? (
          <>
            <span className="h-1 w-18 overflow-hidden rounded-full bg-input">
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${stage.percent ?? 0}%` }}
              />
            </span>
            <span className="text-foreground">{stage.percent}%</span>
          </>
        ) : null}
        {!showBar && trailing ? <span className="truncate">{trailing}</span> : null}
        {elapsed !== null && stage.status !== "skipped" && stage.status !== "pending" ? (
          <span>{formatDuration(elapsed)}</span>
        ) : null}
      </span>
    </div>
  );
}

function OutputTail({ lines, failed }: { lines: ReadonlyArray<string>; failed: boolean }) {
  if (lines.length === 0) return null;
  return (
    <pre
      className={cn(
        "mb-1 ml-8 max-h-20 overflow-hidden rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all select-text",
        failed
          ? "border-destructive/20 bg-error-surface text-destructive-foreground"
          : "border-border bg-code text-muted-foreground",
      )}
    >
      {lines.join("\n")}
    </pre>
  );
}

function headerLabel(snapshot: WorktreeSetupSnapshot): string {
  switch (snapshot.phase) {
    case "running":
      return "Creating worktree";
    case "done":
      return "Worktree ready";
    case "failed":
      return "Worktree setup failed";
    case "cancelled":
      return "Worktree setup cancelled";
  }
}

export function WorktreeSetupCard({
  snapshot,
  onCancel,
  onWorkLocally,
  onOpenTerminal,
}: WorktreeSetupCardProps) {
  const running = snapshot.phase === "running";
  const nowMs = useNowWhile(running);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const totalElapsed = (() => {
    const start = Date.parse(snapshot.startedAt);
    const end = snapshot.endedAt ? Date.parse(snapshot.endedAt) : nowMs;
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  })();
  const setupStage = snapshot.stages.find((stage) => stage.id === "setup-script");
  const failed = snapshot.phase === "failed";
  const headerClassName = failed
    ? "text-destructive-foreground"
    : snapshot.phase === "cancelled"
      ? "text-muted-foreground"
      : "text-secondary-label";

  return (
    <section
      aria-label="Worktree setup"
      className="mt-3 rounded-lg border border-border bg-card/60 px-2.5 pt-1.5 pb-2"
      data-worktree-setup-phase={snapshot.phase}
    >
      <div className={cn("flex min-h-6 items-center gap-1.5 px-0.5 text-sm", headerClassName)}>
        <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
          <GitBranchIcon aria-hidden className="size-4 shrink-0 stroke-[1.8]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{headerLabel(snapshot)}</span>
        {totalElapsed !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDuration(totalElapsed)}
          </span>
        ) : null}
      </div>

      {snapshot.stages.map((stage) => (
        <div key={stage.id}>
          <StageRow stage={stage} nowMs={nowMs} scriptName={snapshot.setupScript?.name ?? null} />
          {stage.id === "setup-script" &&
          (stage.status === "running" || stage.status === "failed") ? (
            <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
          ) : null}
        </div>
      ))}

      {failed && snapshot.error ? (
        <p className="mt-1 px-0.5 text-xs text-muted-foreground">{snapshot.error}</p>
      ) : null}

      {detailsOpen ? (
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
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
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
        <span className="flex-1" />
        {onOpenTerminal && setupStage && setupStage.status !== "pending" ? (
          <Button type="button" size="xs" variant="outline" onClick={onOpenTerminal}>
            <TerminalIcon aria-hidden />
            Open terminal
          </Button>
        ) : null}
        {onWorkLocally ? (
          <Button type="button" size="xs" variant="outline" onClick={onWorkLocally}>
            <LaptopIcon aria-hidden />
            Work locally
          </Button>
        ) : null}
        {onCancel && running ? (
          <Button type="button" size="xs" variant="outline" onClick={onCancel}>
            <XIcon aria-hidden />
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}
