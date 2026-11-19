import {
  type ComputerActivityEntry,
  computerLiveApprovals,
  computerStripEntries,
  computerTaskLastStep,
  nextComputerApprovalDeadline,
} from "@t3tools/client-runtime/state/computer";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useParams } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { T, useGT } from "gt-react";
import { MonitorIcon } from "lucide-react";
import { useState } from "react";

import { useNowAfter } from "../../hooks/useDeadline";
import { tickTextContent } from "../../lib/tickTextContent";
import { stopComputerTasks, useComputerActivity } from "../../state/computer";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { InlineButton } from "../ui/button";
import { ComputerApprovalCard } from "./ComputerApprovalCard";

/** One environment's running task: its last step, the tap it waits for, and Stop. */
function StripTask({ entry }: { readonly entry: ComputerActivityEntry }) {
  const gt = useGT();
  // Re-reads the clock once, when the tap this task waits for lapses.
  const nowMs = useNowAfter(nextComputerApprovalDeadline(entry.approvals));
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { task } = entry;
  const approval = computerLiveApprovals(entry.approvals, nowMs)[0];
  const lastStep = computerTaskLastStep(task);
  const startedAtMs = DateTime.toEpochMillis(task.startedAt);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    setError(await stopComputerTasks({ environmentId: entry.environmentId, taskId: task.taskId }));
    setStopping(false);
  };

  return (
    <div
      data-computer-strip-task=""
      role="group"
      aria-label={gt("Computer use on {environment}", { environment: entry.environmentLabel })}
      className="flex min-w-0 flex-col gap-1 border-b border-border/40 py-1.5 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-2">
        <MonitorIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">
          <span className="font-medium">{task.goal}</span>
          <span className="text-muted-foreground"> · {entry.environmentLabel}</span>
          {lastStep === null ? null : <span className="text-muted-foreground"> · {lastStep}</span>}
        </span>
        {task.approvalsMode === "skip" ? (
          <span className="shrink-0 text-muted-foreground">
            <T>approvals off</T>
          </span>
        ) : null}
        <span
          ref={tickTextContent(
            (clockMs) => formatDuration(Math.max(0, clockMs - startedAtMs)),
            true,
          )}
          className="shrink-0 text-muted-foreground tabular-nums"
        />
        <InlineButton tone="muted" disabled={stopping} onClick={() => void stop()}>
          {stopping
            ? gt("Stopping...")
            : gt("Stop", { $context: "button, stops a running computer task" })}
        </InlineButton>
      </div>
      {approval === undefined ? null : (
        <ComputerApprovalCard
          environmentId={entry.environmentId}
          environmentLabel={entry.environmentLabel}
          approval={approval}
        />
      )}
      {error === null ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Computer use anywhere, for every screen: each running task on any environment, the tap it
 * waits for, and Stop. The open thread's own taps are above its composer instead. It floats where
 * the dictation pill does, so it never covers a composer or a thread header, and it re-renders
 * when a task's step changes, never on a timer of its own.
 */
export function ComputerActivityStrip() {
  const viewing = useParams({ strict: false, select: resolveThreadRouteRef });
  const activity = computerStripEntries(useComputerActivity(), viewing);
  if (activity.length === 0) return null;
  return (
    <div
      data-computer-activity-strip=""
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--workspace-topbar-height)+0.5rem)] z-40 flex justify-center px-4"
    >
      <div className="pointer-events-auto flex max-h-[70dvh] w-full max-w-2xl flex-col overflow-auto rounded-xl border border-border/60 bg-popover/95 px-3 py-1.5 text-xs shadow-lg/5 backdrop-blur">
        {activity.map((entry) => (
          <StripTask key={`${entry.environmentId}:${entry.task.taskId}`} entry={entry} />
        ))}
      </div>
    </div>
  );
}
