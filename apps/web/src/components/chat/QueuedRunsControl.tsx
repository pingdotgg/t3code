import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, CornerUpRightIcon, ListOrderedIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function QueuedRunsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;

  if (queued.length === 0) return null;

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    await reorder({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId, beforeRunId },
    });
    setBusyRunId(null);
  };

  const steer = async (queuedRunId: RunId) => {
    if (activeRun === null) return;
    setBusyRunId(queuedRunId);
    await promote({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
    });
    setBusyRunId(null);
  };

  return (
    <section className="mx-auto mb-2 max-w-208 rounded-xl border border-border bg-background/96 shadow-xs">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium">
        <ListOrderedIcon className="size-3.5 text-muted-foreground" />
        Queue
        <span className="ml-auto tabular-nums text-muted-foreground">{queued.length}</span>
      </header>
      <ol className="max-h-40 overflow-y-auto p-1.5">
        {queued.map(({ run, text }, index) => (
          <li key={run.id} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs">{text}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Move queued message up"
              disabled={busyRunId !== null || !workflow?.canReorder || index === 0}
              onClick={() => void move(run.id, queued[index - 1]?.run.id ?? null)}
            >
              <ArrowUpIcon className="size-3" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Move queued message down"
              disabled={busyRunId !== null || !workflow?.canReorder || index === queued.length - 1}
              onClick={() => void move(run.id, queued[index + 2]?.run.id ?? null)}
            >
              <ArrowDownIcon className="size-3" />
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busyRunId !== null || !workflow?.canPromoteToSteer}
              title={activeRun === null ? "There is no active run to steer" : "Promote to steer"}
              onClick={() => void steer(run.id)}
            >
              <CornerUpRightIcon className="size-3" />
              Steer
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
