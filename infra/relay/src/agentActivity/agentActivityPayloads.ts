import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

export function isTerminalPhase(state: RelayAgentActivityState): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

// Rows are only removed when their environment publishes a terminal state. An
// environment that dies mid-run (machine off, process killed) never does, so
// without an age cutoff its threads inflate activeCount forever. Actively
// running phases expire quickly; waiting phases can legitimately sit for hours
// while a user ignores an approval prompt, so they get a longer window. The
// underlying database row is left in place: a late publish for the thread
// refreshes updatedAt and the row becomes visible again.
const RUNNING_AGENT_ACTIVITY_ROW_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_AGENT_ACTIVITY_ROW_TTL_MS = 24 * 60 * 60 * 1_000;

export function isExpiredAgentActivityState(
  state: RelayAgentActivityState,
  nowMs: number,
): boolean {
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return true;
  }
  const ttlMs =
    state.phase === "running" || state.phase === "starting"
      ? RUNNING_AGENT_ACTIVITY_ROW_TTL_MS
      : WAITING_AGENT_ACTIVITY_ROW_TTL_MS;
  return nowMs - updatedAtMs > ttlMs;
}

const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
// The Live Activity banner (lock screen / Notification Center) renders up to
// five rows; the expanded Dynamic Island shows the top three of these.
export const MAX_ACTIVITY_ROWS = 5;

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength - 3).trimEnd() + "...";
}

function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return "/";
  }
  return truncateText(trimmed, MAX_DEEP_LINK_LENGTH);
}

export function sanitizeAgentActivityAggregateRow(
  row: RelayAgentActivityAggregateRow,
): RelayAgentActivityAggregateRow {
  return {
    ...row,
    projectTitle: truncateText(row.projectTitle, MAX_SUMMARY_TEXT_LENGTH),
    threadTitle: truncateText(row.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
    modelTitle: truncateText(row.modelTitle, MAX_SUMMARY_TEXT_LENGTH),
    status: truncateText(row.status, MAX_STATUS_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(row.deepLink),
  };
}

export function sanitizeAgentActivityAggregateState(
  aggregate: RelayAgentActivityAggregateState,
): RelayAgentActivityAggregateState {
  return {
    ...aggregate,
    title: truncateText(aggregate.title, MAX_SUMMARY_TEXT_LENGTH),
    subtitle: truncateText(aggregate.subtitle, MAX_SUMMARY_TEXT_LENGTH),
    activities: aggregate.activities
      .slice(0, MAX_ACTIVITY_ROWS)
      .map(sanitizeAgentActivityAggregateRow),
  };
}

export function sanitizeApnsNotificationPayload(
  notification: ApnsNotificationPayload,
): ApnsNotificationPayload {
  return {
    ...notification,
    title: truncateText(notification.title, MAX_SUMMARY_TEXT_LENGTH),
    body: truncateText(notification.body, MAX_SUMMARY_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(notification.deepLink),
  };
}
