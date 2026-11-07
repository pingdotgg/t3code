import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { agentActivityNotificationCopy } from "./agentActivityPayloads.ts";

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  const epochMs = timestamp?.epochMilliseconds ?? Date.parse(updatedAt);
  return Number.isFinite(epochMs) && nowMs - epochMs <= TERMINAL_NOTIFICATION_FRESHNESS_MS;
}

/** Registration always enables every notifyOn* flag; repair rows that only ring for attention. */
export function repairAwarenessPreferences(
  preferences: RelayAgentAwarenessPreferences,
): RelayAgentAwarenessPreferences {
  if (
    !preferences.notificationsEnabled ||
    !preferences.notifyOnApproval ||
    !preferences.notifyOnInput ||
    (preferences.notifyOnCompletion && preferences.notifyOnFailure)
  ) {
    return preferences;
  }
  return {
    ...preferences,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  };
}

type TransitionInput = {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
};

function rowKey(row: RelayAgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

export function rowPhasesChanged(
  previousAggregate: RelayAgentActivityAggregateState,
  nextAggregate: RelayAgentActivityAggregateState,
): boolean {
  if (previousAggregate.activities.length !== nextAggregate.activities.length) return true;
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.some((row) => previousPhases.get(rowKey(row)) !== row.phase);
}

export function rowStatusesChanged(
  previousAggregate: RelayAgentActivityAggregateState,
  nextAggregate: RelayAgentActivityAggregateState,
): boolean {
  if (previousAggregate.activities.length !== nextAggregate.activities.length) return true;
  const previousStatuses = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.status]),
  );
  return nextAggregate.activities.some((row) => previousStatuses.get(rowKey(row)) !== row.status);
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

// A missing baseline is a replay, not a transition that should buzz the phone.
export function attentionTransitionRows(input: TransitionInput) {
  if (input.previousAggregate === null) return [];
  const previouslyAttention = new Set(
    input.previousAggregate.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  return input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedForPhase(input.preferences, row.phase),
  );
}

function newlyTerminalRows(
  previousAggregate: RelayAgentActivityAggregateState | null,
  nextAggregate: RelayAgentActivityAggregateState,
  includeUnobserved = false,
): ReadonlyArray<RelayAgentActivityAggregateRow> {
  if (previousAggregate === null) return [];
  const previousPhases = new Map(
    previousAggregate.activities.map((row) => [rowKey(row), row.phase]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const previousPhase = previousPhases.get(rowKey(row));
    return (
      (includeUnobserved || previousPhase !== undefined) &&
      previousPhase !== "completed" &&
      previousPhase !== "failed"
    );
  });
}

export function terminalTransitionRows(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
) {
  return newlyTerminalRows(
    input.previousAggregate,
    input.nextAggregate,
    input.includeUnobserved,
  ).filter((row) => {
    return (
      alertAllowedForPhase(input.preferences, row.phase) &&
      isFreshTerminalNotification(row.updatedAt, input.nowMs)
    );
  });
}

export function alertForActivityRows(
  rows: ReadonlyArray<RelayAgentActivityAggregateRow>,
): AgentActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return agentActivityNotificationCopy(first);
  }
  return {
    title: isAttentionPhase(first.phase)
      ? `${rows.length} need your reply`
      : `${rows.length} ready to review`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function alertForAttentionTransition(input: TransitionInput): AgentActivityAlert | null {
  return alertForActivityRows(attentionTransitionRows(input));
}

export function alertForNewlyTerminal(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
): AgentActivityAlert | null {
  return alertForActivityRows(terminalTransitionRows(input));
}

export function alertForTerminalAggregate(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedForPhase(input.preferences, row.phase) ? alertForActivityRows([row]) : null;
}

export function shouldAlertForActivity(input: {
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase(input.preferences, input.phase) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}
