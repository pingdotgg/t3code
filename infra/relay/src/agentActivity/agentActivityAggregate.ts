import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  isExpiredAgentActivityState,
  isTerminalPhase,
  MAX_ACTIVITY_ROWS,
  sanitizeAgentActivityAggregateState,
} from "./agentActivityPayloads.ts";

export function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      // Match the web sidebar's wording in Sidebar.logic.ts.
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRowForState(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

function terminalAggregateState(state: RelayAgentActivityState): RelayAgentActivityAggregateState {
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: state.phase === "failed" ? "Agent work failed" : "Agent work completed",
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities: [aggregateRowForState(state)],
  });
}

export const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 15 * 60 * 1_000;

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) {
    return false;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const activeStates = input.activeStates.filter(
    (state) => !isTerminalPhase(state) && !isExpiredAgentActivityState(state, input.nowMs),
  );
  if (activeStates.length === 0) {
    if (input.terminalState !== null) {
      return terminalAggregateState(input.terminalState);
    }
    // Alerts compare with the delivered aggregate; replays must repaint without buzzing.
    const recentTerminal = input.activeStates
      .filter((state) => isRecentTerminalState(state, input.nowMs))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const newest = recentTerminal[0];
    if (!newest) {
      return null;
    }
    return sanitizeAgentActivityAggregateState({
      title: "T3 Code",
      subtitle: newest.phase === "failed" ? "Agent work failed" : "Agent work completed",
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities: recentTerminal.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState),
    });
  }
  const recentTerminalStates = input.activeStates
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const displayedStates = [
    ...activeStates
      .toSorted((a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase))
      .slice(0, MAX_ACTIVITY_ROWS),
    ...recentTerminalStates,
  ].slice(0, MAX_ACTIVITY_ROWS);
  const updatedAt = [...activeStates, ...recentTerminalStates].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayedStates.map(aggregateRowForState),
  });
}

export function activityPhasePriority(phase: RelayAgentActivityState["phase"]): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}
