/**
 * Pure selection + copy decisions for the agent-run tracker pill.
 *
 * The tracker never derives its own runs: it is handed the same `AgentRun[]`
 * the transcript renders, so the pill and the cards can never disagree.
 */

import type { AgentRun } from "../../agentRuns.ts";
import { isTerminalAgentRunPhase } from "../../agentRuns.ts";

/** A tracker popover is a "what is happening" panel, not a history log. */
export const AGENT_RUN_TRACKER_FINISHED_CAP = 20;

export interface AgentRunTrackerState {
  /** Non-terminal runs, in timeline order. */
  readonly running: ReadonlyArray<AgentRun>;
  /** Settled runs, newest first, capped at {@link AGENT_RUN_TRACKER_FINISHED_CAP}. */
  readonly finished: ReadonlyArray<AgentRun>;
  /** False when the thread never dispatched an agent — the pill stays out of the header. */
  readonly visible: boolean;
  /** Running count while anything is live, otherwise the settled count. */
  readonly count: number;
  /** Drives the pulsing dot; false means no repeating animation is mounted at all. */
  readonly active: boolean;
  readonly tooltip: string;
}

export function selectAgentRunTrackerState(runs: ReadonlyArray<AgentRun>): AgentRunTrackerState {
  const running: AgentRun[] = [];
  const finished: AgentRun[] = [];
  // Ambient runs are deliberately included: the SDK hides them from the
  // transcript but says they "may still appear in a tasks panel".
  for (const run of runs) {
    if (isTerminalAgentRunPhase(run.phase)) {
      finished.push(run);
    } else {
      running.push(run);
    }
  }
  running.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  finished.sort((a, b) => settledKey(b).localeCompare(settledKey(a)));
  const cappedFinished = finished.slice(0, AGENT_RUN_TRACKER_FINISHED_CAP);

  const active = running.length > 0;
  const count = active ? running.length : cappedFinished.length;
  return {
    running,
    finished: cappedFinished,
    visible: running.length > 0 || cappedFinished.length > 0,
    count,
    active,
    tooltip: agentRunTrackerTooltip(running.length, cappedFinished.length),
  };
}

export function agentRunTrackerTooltip(runningCount: number, finishedCount: number): string {
  if (runningCount > 0) {
    return `${runningCount} agent ${runningCount === 1 ? "run" : "runs"} in progress`;
  }
  return `${finishedCount} finished agent ${finishedCount === 1 ? "run" : "runs"}`;
}

/**
 * Opening the pill with nothing running must never show an empty popover, so
 * the finished section reveals itself in that case (2code's `onPillClick`).
 */
export function shouldRevealFinishedOnOpen(state: AgentRunTrackerState): boolean {
  return state.running.length === 0;
}

/** Rows rendered by the popover for the current disclosure state. */
export function agentRunTrackerRows(
  state: AgentRunTrackerState,
  showFinished: boolean,
): ReadonlyArray<AgentRun> {
  return showFinished ? [...state.running, ...state.finished] : state.running;
}

/**
 * Ambient runs are removed from the transcript, so offering "jump to transcript"
 * for one would scroll to a row that does not exist.
 */
export function agentRunIsJumpable(run: AgentRun): boolean {
  return !run.ambient;
}

function settledKey(run: AgentRun): string {
  return run.settledAt ?? run.createdAt;
}
