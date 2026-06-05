import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
} from "@t3tools/contracts/relay";
import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
const MAX_ACTIVITY_ROWS = 3;

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
