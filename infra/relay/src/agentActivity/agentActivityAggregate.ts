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

function inboxSubtitle(input: {
  readonly activeCount: number;
  readonly activities: ReadonlyArray<{ readonly phase: RelayAgentActivityState["phase"] }>;
  readonly terminalOnly: boolean;
  readonly failed: boolean;
}): string {
  const needsAttention = input.activities.filter(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  ).length;
  if (needsAttention > 0) {
    return needsAttention === 1 ? "1 needs your reply" : `${needsAttention} need your reply`;
  }
  if (input.activeCount > 0) {
    return input.activeCount === 1 ? "1 working" : `${input.activeCount} working`;
  }
  if (input.terminalOnly) {
    return input.failed ? "Failed" : "All caught up";
  }
  return "All caught up";
}

function terminalAggregateState(state: RelayAgentActivityState): RelayAgentActivityAggregateState {
  const activities = [aggregateRowForState(state)];
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: inboxSubtitle({
      activeCount: 0,
      activities,
      terminalOnly: true,
      failed: state.phase === "failed",
    }),
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities,
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
    const activities = recentTerminal.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState);
    return sanitizeAgentActivityAggregateState({
      title: "T3 Code",
      subtitle: inboxSubtitle({
        activeCount: 0,
        activities,
        terminalOnly: true,
        failed: recentTerminal.some((state) => state.phase === "failed"),
      }),
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities,
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
  const activities = displayedStates.map(aggregateRowForState);
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: inboxSubtitle({
      activeCount: activeStates.length,
      activities,
      terminalOnly: false,
      failed: false,
    }),
    activeCount: activeStates.length,
    updatedAt,
    activities,
  });
}

export function activityPhasePriority(phase: RelayAgentActivityState["phase"]): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}
