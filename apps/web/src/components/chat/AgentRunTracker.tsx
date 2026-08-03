import { CornerUpRightIcon, WorkflowIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import type { AgentRun } from "../../agentRuns.ts";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AgentRunCard } from "./AgentRunCard.tsx";
import {
  agentRunIsJumpable,
  agentRunTrackerRows,
  selectAgentRunTrackerState,
  shouldRevealFinishedOnOpen,
} from "./AgentRunTracker.logic.ts";
// fork: f3 — per-task stop (increment 4)
import { useAgentRunStop } from "./agentRunStop.ts";
import {
  AGENT_RUN_STOP_ALL_DISARM_MS,
  agentRunStopAllLabel,
  stoppableAgentRuns,
} from "./agentRunStop.logic.ts";

/**
 * The persistent "what is running" pill.
 *
 * Fed the same `AgentRun[]` the transcript renders — never a second derivation —
 * and mounted in the chat header rather than the composer footer, so it is never
 * width-gated out of existence while work is in flight.
 */
export const AgentRunTracker = memo(function AgentRunTracker({
  runs,
  onJumpToRun,
}: {
  runs: ReadonlyArray<AgentRun>;
  /** Returns false when the run has no transcript row to scroll to. */
  onJumpToRun?: (taskId: string) => boolean;
}) {
  const state = useMemo(() => selectAgentRunTrackerState(runs), [runs]);
  const [open, setOpen] = useState(false);
  const [showFinished, setShowFinished] = useState(false);

  if (!state.visible) {
    return null;
  }

  const rows = agentRunTrackerRows(state, showFinished);
  const finishedCount = state.finished.length;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Opening with nothing running must never show an empty popover.
          setShowFinished(shouldRevealFinishedOnOpen(state));
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={state.tooltip}
            size="xs"
            title={state.tooltip}
            variant="outline"
            className="gap-1.5 tabular-nums"
          />
        }
      >
        {state.active ? (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-primary animate-status-pulse"
          />
        ) : (
          <WorkflowIcon aria-hidden="true" className="size-3.5 opacity-70" />
        )}
        {state.count}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" side="bottom">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <span className="text-xs font-medium text-foreground/80">
            {state.active ? `${state.running.length} running` : "Agent runs"}
          </span>
          {/* fork: f3 — Stop all, two-press with a 3 s disarm. */}
          <AgentRunStopAllButton runs={state.running} />
          {finishedCount > 0 ? (
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              onClick={() => setShowFinished((previous) => !previous)}
            >
              {showFinished ? "Hide finished" : `Show finished (${finishedCount})`}
            </button>
          ) : null}
        </div>
        <div className="max-h-96 overflow-y-auto overscroll-contain px-2 py-1.5">
          {rows.map((run, index) => (
            <div key={run.taskId}>
              {showFinished && state.running.length > 0 && index === state.running.length ? (
                <p className="px-1 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                  Finished
                </p>
              ) : null}
              <AgentRunTrackerRow
                run={run}
                {...(onJumpToRun ? { onJump: onJumpToRun } : {})}
                onJumped={() => setOpen(false)}
              />
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

/**
 * fork: f3 — the destructive control the popover header owns.
 *
 * Two presses, because stopping every running agent at once is not undoable,
 * and the arm decays after {@link AGENT_RUN_STOP_ALL_DISARM_MS} so a stray
 * click cannot leave a loaded trigger sitting in the header.
 */
function AgentRunStopAllButton({ runs }: { runs: ReadonlyArray<AgentRun> }) {
  const stop = useAgentRunStop();
  const [armed, setArmed] = useState(false);
  const stoppable = stoppableAgentRuns(runs);

  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), AGENT_RUN_STOP_ALL_DISARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  // Disarm as soon as there is nothing left to stop, so the confirm state
  // cannot outlive the runs it was aimed at.
  useEffect(() => {
    if (stoppable.length === 0 && armed) {
      setArmed(false);
    }
  }, [armed, stoppable.length]);

  if (!stop.enabled || stoppable.length === 0) {
    return null;
  }

  return (
    <button
      type="button"
      className={cn(
        "ml-auto cursor-pointer rounded px-1.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        armed
          ? "bg-destructive/12 text-destructive"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        stop.stopRuns(stoppable.map((run) => run.taskId));
      }}
    >
      {agentRunStopAllLabel(stoppable.length, armed)}
    </button>
  );
}

function AgentRunTrackerRow({
  run,
  onJump,
  onJumped,
}: {
  run: AgentRun;
  onJump?: (taskId: string) => boolean;
  onJumped: () => void;
}) {
  const jumpable = onJump !== undefined && agentRunIsJumpable(run);
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <AgentRunCard run={run} density="compact" />
      </div>
      {run.ambient ? (
        <span
          className="mt-1.5 shrink-0 px-1 text-[10px] text-muted-foreground/50"
          title="Housekeeping task — hidden from the transcript"
        >
          background
        </span>
      ) : jumpable ? (
        <button
          type="button"
          aria-label={`Jump to ${run.title} in the transcript`}
          title="Jump to transcript"
          className={cn(
            "mt-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground/70 transition-colors",
            "hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          )}
          onClick={() => {
            if (onJump?.(run.taskId)) {
              onJumped();
            }
          }}
        >
          <CornerUpRightIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
