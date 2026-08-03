import { WorkflowIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import type { AgentRun } from "../../agentRuns.ts";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Group } from "../ui/group";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentRunCard } from "./AgentRunCard.tsx";
import {
  agentRunIsJumpable,
  agentRunTrackerRows,
  selectAgentRunTrackerState,
  shouldRevealFinishedOnOpen,
} from "./AgentRunTracker.logic.ts";
import { agentRunStopAllButtonLabel, agentRunStopAllTooltip } from "./agentRunPresentation.ts";
// fork: f3 — per-task stop (increment 4)
import { useAgentRunStop } from "./agentRunStop.ts";
import { AGENT_RUN_STOP_ALL_DISARM_MS, stoppableAgentRuns } from "./agentRunStop.logic.ts";

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

  // The last run can settle *while* the popover is open, so the disclosure is
  // re-evaluated on state change and not only on open — otherwise the body
  // collapses to an empty strip under a header that still offers "Show finished".
  useEffect(() => {
    if (open && shouldRevealFinishedOnOpen(state)) {
      setShowFinished(true);
    }
  }, [open, state]);

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
            className="gap-1.5 tabular-nums"
            size="xs"
            title={state.tooltip}
            variant="outline"
          />
        }
      >
        {state.active ? (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-primary motion-reduce:animate-none"
          />
        ) : (
          <WorkflowIcon aria-hidden="true" className="size-3.5 opacity-70" />
        )}
        {state.count}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" side="bottom">
        {/* Three slots that cannot collide: a shrinkable label and one
            fixed-order action group. */}
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/80 text-xs">
            {state.active ? `${state.running.length} running` : "Agent runs"}
          </span>
          <Group className="shrink-0">
            {finishedCount > 0 ? (
              <Button
                className="gap-1 text-muted-foreground"
                onClick={() => setShowFinished((previous) => !previous)}
                size="xs"
                variant="ghost"
              >
                {showFinished ? "Hide finished" : "Show finished"}
                <Badge className="font-normal tabular-nums" size="sm" variant="secondary">
                  {finishedCount}
                </Badge>
              </Button>
            ) : null}
            {/* fork: f3 — Stop all, two-press with a 3 s disarm. */}
            <AgentRunStopAllButton runs={state.running} />
          </Group>
        </div>
        <div className="max-h-96 overflow-y-auto overscroll-contain px-1.5 py-1.5">
          {rows.length === 0 ? (
            <AgentRunTrackerEmpty
              finishedCount={finishedCount}
              onShowFinished={() => setShowFinished(true)}
            />
          ) : (
            rows.map((run, index) => (
              <div key={run.taskId}>
                {showFinished && state.running.length > 0 && index === state.running.length ? (
                  <div className="pt-2 pb-1">
                    <Separator className="mb-1.5" />
                    <p className="px-1 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-[0.08em]">
                      Finished
                    </p>
                  </div>
                ) : null}
                <AgentRunTrackerRow
                  run={run}
                  {...(onJumpToRun ? { onJump: onJumpToRun } : {})}
                  onJumped={() => setOpen(false)}
                />
              </div>
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});

function AgentRunTrackerEmpty({
  finishedCount,
  onShowFinished,
}: {
  finishedCount: number;
  onShowFinished: () => void;
}) {
  return (
    <Empty className="gap-3 p-6 md:p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WorkflowIcon />
        </EmptyMedia>
        <EmptyTitle className="text-base">No agent runs</EmptyTitle>
        <EmptyDescription className="text-xs">
          Delegated agents and workflows show up here while they work.
        </EmptyDescription>
      </EmptyHeader>
      {finishedCount > 0 ? (
        <EmptyContent>
          <Button className="gap-1" onClick={onShowFinished} size="xs" variant="outline">
            Show finished
            <Badge className="font-normal tabular-nums" size="sm" variant="secondary">
              {finishedCount}
            </Badge>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

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
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            // Fixed width: the label swap used to move the destructive target
            // between the two presses it requires.
            <Button
              className={cn("min-w-24", armed ? null : "text-muted-foreground")}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                stop.stopRuns(stoppable.map((run) => run.taskId));
              }}
              size="xs"
              variant={armed ? "destructive" : "ghost"}
            >
              {agentRunStopAllButtonLabel(armed)}
            </Button>
          }
        />
        <TooltipPopup>{agentRunStopAllTooltip(stoppable.length, armed)}</TooltipPopup>
      </Tooltip>
      {/* The confirm step is otherwise silent to assistive tech. */}
      <span aria-live="polite" className="sr-only">
        {armed ? agentRunStopAllTooltip(stoppable.length, true) : ""}
      </span>
    </>
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
  // fork: f3 F-21 — a jump that misses (the timeline is not mounted yet, or the
  // run has no row) used to do literally nothing: the popover did not even
  // close. Close it either way and say why.
  const jump = () => {
    const jumped = onJump?.(run.taskId) === true;
    onJumped();
    if (!jumped) {
      toastManager.add({
        type: "info",
        title: "That run is not in the transcript right now",
        description: "Scroll the conversation or reopen the thread, then try again.",
        timeout: 5_000,
      });
    }
  };
  return <AgentRunCard run={run} density="compact" {...(jumpable ? { onJump: jump } : {})} />;
}
