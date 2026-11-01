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
    case "woke":
      return "Woke";
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
    ...(state.unread === undefined ? {} : { unread: state.unread }),
    ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
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
  return state.retained === true || nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const states = input.activeStates.filter((state) =>
    isTerminalPhase(state)
      ? isRecentTerminalState(state, input.nowMs)
      : !isExpiredAgentActivityState(state, input.nowMs),
  );
  if (states.length === 0 && input.terminalState !== null) states.push(input.terminalState);
  if (states.length === 0) return null;
  const activeCount = states.filter((state) => !isTerminalPhase(state)).length;
  const unreadCount = states.filter(
    (state) => state.phase === "completed" && state.unread !== false,
  ).length;
  const pendingCount =
    activeCount + states.filter((state) => isTerminalPhase(state) && state.unread !== false).length;
  const displayedStates = states
    .toSorted(
      (a, b) =>
        activityPhasePriority(a.phase, a.unread) - activityPhasePriority(b.phase, b.unread) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.environmentId.localeCompare(b.environmentId) ||
        a.threadId.localeCompare(b.threadId),
    )
    .slice(0, MAX_ACTIVITY_ROWS);
  const newest = states.reduce((latest, state) =>
    state.updatedAt > latest.updatedAt ? state : latest,
  );
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle:
      activeCount > 0
        ? "Agent work in progress"
        : newest.phase === "failed"
          ? "Agent work failed"
          : "Agent work completed",
    activeCount,
    workingCount: states.filter((state) => state.phase === "running" || state.phase === "starting")
      .length,
    attentionCount: states.filter(
      (state) =>
        state.phase === "waiting_for_input" ||
        state.phase === "waiting_for_approval" ||
        state.phase === "woke",
    ).length,
    unreadCount,
    // Legacy publishers cannot report reads; keep their existing completion lifecycle.
    ...(states.every((state) => state.unread !== undefined) ||
    states.some((state) => state.unread === true || state.phase === "woke")
      ? { pendingCount }
      : {}),
    totalCount: states.length,
    updatedAt: newest.updatedAt,
    activities: displayedStates.map(aggregateRowForState),
  });
}

export function activityPhasePriority(
  phase: RelayAgentActivityState["phase"],
  unread?: boolean,
): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input" || phase === "woke")
    return 0;
  if (phase === "failed") return 1;
  if (phase === "completed" && unread !== false) return 2;
  if (phase === "starting" || phase === "running") return 3;
  return 4;
}
