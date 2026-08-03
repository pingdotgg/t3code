/**
 * Pure decisions for the agent-run Stop affordance (fork f3, increment 4).
 *
 * There is deliberately **no `stopRequested` field on `AgentRun`**. A run is
 * derived from persisted activities, and "I clicked stop 400 ms ago" is not
 * one — it is view state that must never survive a reload or leak into
 * `agentRunEquals`. It lives here instead, keyed by `taskId`, with an explicit
 * `now` on every function so the whole module is testable without timers.
 *
 * The stop itself is idempotent server-side, so this table is only ever used
 * to shape the button: it can be wrong (stale, cleared, duplicated) without
 * anything worse than a button that re-enables early.
 *
 * @module agentRunStop.logic
 */

import type { AgentRun } from "../../agentRuns.ts";
import { isTerminalAgentRunPhase } from "../../agentRuns.ts";

/**
 * How long a pressed Stop button stays disabled before offering itself again.
 *
 * A stop is confirmed by the run settling, not by the RPC returning — the RPC
 * returns as soon as the provider accepted the request. If nothing settles
 * within this window the request is assumed lost and the user gets the button
 * back rather than a permanently dead control.
 */
export const AGENT_RUN_STOP_REENABLE_MS = 5_000;

/** Two-press confirmation window for the tracker's destructive "Stop all". */
export const AGENT_RUN_STOP_ALL_DISARM_MS = 3_000;

/** `taskId` → epoch ms at which a stop was requested. */
export type AgentRunStopRequests = Readonly<Record<string, number>>;

export const EMPTY_AGENT_RUN_STOP_REQUESTS: AgentRunStopRequests = {};

export function withAgentRunStopRequested(
  requests: AgentRunStopRequests,
  taskIds: ReadonlyArray<string>,
  now: number,
): AgentRunStopRequests {
  if (taskIds.length === 0) {
    return requests;
  }
  const next: Record<string, number> = { ...requests };
  for (const taskId of taskIds) {
    next[taskId] = now;
  }
  return next;
}

export function isAgentRunStopPending(
  requests: AgentRunStopRequests,
  taskId: string,
  now: number,
): boolean {
  const requestedAt = requests[taskId];
  return requestedAt !== undefined && now - requestedAt < AGENT_RUN_STOP_REENABLE_MS;
}

/**
 * Drops entries past the re-enable window. Returns the same object when
 * nothing changed so a store can skip notifying its subscribers.
 */
export function pruneAgentRunStopRequests(
  requests: AgentRunStopRequests,
  now: number,
): AgentRunStopRequests {
  const live = Object.entries(requests).filter(([, requestedAt]) => {
    return now - requestedAt < AGENT_RUN_STOP_REENABLE_MS;
  });
  return live.length === Object.keys(requests).length ? requests : Object.fromEntries(live);
}

/**
 * A run is stoppable while it has not settled. Ambient runs are included:
 * they are hidden from the transcript, not from the tracker, and a runaway
 * housekeeping task is exactly the thing a user wants to be able to kill.
 */
export function agentRunIsStoppable(run: AgentRun): boolean {
  return !isTerminalAgentRunPhase(run.phase);
}

export function stoppableAgentRuns(runs: ReadonlyArray<AgentRun>): ReadonlyArray<AgentRun> {
  return runs.filter(agentRunIsStoppable);
}

export type AgentRunStopButtonState = "hidden" | "idle" | "pending";

export function agentRunStopButtonState(input: {
  readonly run: AgentRun;
  readonly requests: AgentRunStopRequests;
  readonly now: number;
  /** False when the surface cannot address a thread (draft route, no params). */
  readonly enabled: boolean;
}): AgentRunStopButtonState {
  if (!input.enabled || !agentRunIsStoppable(input.run)) {
    return "hidden";
  }
  return isAgentRunStopPending(input.requests, input.run.taskId, input.now) ? "pending" : "idle";
}

/**
 * Copy for a refused stop. The unsupported case is not a failure the user can
 * do anything about, so it gets its own sentence rather than a raw error.
 */
export function agentRunStopFailureMessage(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { _tag?: unknown })._tag === "ProviderTaskStopUnsupportedError"
  ) {
    return "This provider can't stop tasks.";
  }
  const message = error instanceof Error ? error.message : undefined;
  return message !== undefined && message.trim().length > 0
    ? message
    : "The server refused the stop request.";
}

/** `Stop all (3)` / `Stop 3 runs?` — the two presses of the tracker control. */
export function agentRunStopAllLabel(count: number, armed: boolean): string {
  if (armed) {
    return count === 1 ? "Stop it?" : `Stop ${count} runs?`;
  }
  return `Stop all (${count})`;
}
