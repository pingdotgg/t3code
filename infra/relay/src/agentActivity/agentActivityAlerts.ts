import {
  RelayAgentAwarenessPreferences,
  type RelayAgentActivityAggregateRow,
  type RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A device's settings plus, set by the relay, when each environment was last turned back on. */
export const DeliveryPreferences = Schema.Struct({
  ...RelayAgentAwarenessPreferences.fields,
  environmentRevealedAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
});
export type DeliveryPreferences = typeof DeliveryPreferences.Type;

/** Records when each environment leaves the muted list; entries for muted ones are dropped. */
export function nextEnvironmentRevealedAt(input: {
  readonly previousMuted: ReadonlyArray<string>;
  readonly previousRevealedAt: Readonly<Record<string, number>> | null;
  readonly nextMuted: ReadonlyArray<string>;
  readonly nowMs: number;
}): Record<string, number> | null {
  const next: Record<string, number> = { ...input.previousRevealedAt };
  for (const environmentId of input.previousMuted) {
    if (!input.nextMuted.includes(environmentId)) next[environmentId] = input.nowMs;
  }
  for (const environmentId of input.nextMuted) delete next[environmentId];
  return Object.keys(next).length > 0 ? next : null;
}

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const timestamp = Option.getOrNull(DateTime.make(updatedAt));
  return (
    timestamp !== null && nowMs - timestamp.epochMilliseconds <= TERMINAL_NOTIFICATION_FRESHNESS_MS
  );
}

type TransitionInput = {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: DeliveryPreferences | null;
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

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

function alertAllowed(
  preferences: DeliveryPreferences | null,
  row: { readonly phase: string; readonly environmentId: string; readonly updatedAt: string },
): boolean {
  if (preferences === null) return true;
  if (preferences.mutedEnvironmentIds?.some((muted) => muted === row.environmentId)) return false;
  // Activity from while the environment was off stays quiet once it is turned back on.
  const revealedAt = preferences.environmentRevealedAt?.[row.environmentId];
  if (revealedAt !== undefined && !(Date.parse(row.updatedAt) > revealedAt)) return false;
  const { phase } = row;
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
      alertAllowed(input.preferences, row),
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
      alertAllowed(input.preferences, row) &&
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
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
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
  readonly preferences: DeliveryPreferences | null;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowed(input.preferences, row) ? alertForActivityRows([row]) : null;
}

export function shouldAlertForActivity(input: {
  readonly environmentId: string;
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly preferences: DeliveryPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowed(input.preferences, input) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}
