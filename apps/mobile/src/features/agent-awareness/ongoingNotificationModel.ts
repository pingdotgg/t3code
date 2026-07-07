import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Notifications from "expo-notifications";

import { agentPhaseAccentColor, agentPhaseStatusLabel } from "../threads/agentPhaseIndicatorModel";
import { AGENT_NOTIFICATION_CHANNEL_IDS } from "./notificationChannels";

export const ONGOING_AGENT_NOTIFICATION_TAG = "t3-agent-aggregate" as const;

const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;

const FORBIDDEN_BODY_PATTERNS = [
  /\bstdout\b/i,
  /\bstderr\b/i,
  /\btool[_\s-]?output\b/i,
  /(?:^|\s)(?:\/[\w.-]+)+\/[\w.-]+\.[A-Za-z0-9]{1,8}(?:\s|$)/,
  /(?:^|\s)[A-Za-z]:\\[\w\\.-]+\.[A-Za-z0-9]{1,8}(?:\s|$)/,
] as const;

export type OngoingAgentNotificationPhase = "running" | "waiting_for_approval";

export function shouldShowOngoingAgentNotification(
  aggregate: RelayAgentActivityAggregateState | null,
): aggregate is RelayAgentActivityAggregateState {
  if (!aggregate || aggregate.activeCount <= 0) {
    return false;
  }
  const primary = aggregate.activities[0];
  if (!primary) {
    return false;
  }
  return primary.phase === "running" || primary.phase === "waiting_for_approval";
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatUpdatedAtLabel(updatedAt: string): string {
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) {
    return "now";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function formatExpandedBody(aggregate: RelayAgentActivityAggregateState): string {
  const lines: string[] = [`${aggregate.activeCount} active`];
  for (const row of aggregate.activities) {
    lines.push(
      truncateText(row.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
      `${truncateText(row.projectTitle, MAX_SUMMARY_TEXT_LENGTH)} · ${truncateText(row.modelTitle, MAX_SUMMARY_TEXT_LENGTH)} — ${truncateText(row.status, MAX_STATUS_TEXT_LENGTH)}`,
    );
  }
  lines.push(`Updated ${formatUpdatedAtLabel(aggregate.updatedAt)}`);
  return lines.join("\n");
}

export function ongoingNotificationBodyPassesSec032(body: string): boolean {
  return !FORBIDDEN_BODY_PATTERNS.some((pattern) => pattern.test(body));
}

export function buildOngoingAgentNotificationContent(
  aggregate: RelayAgentActivityAggregateState,
  colorScheme: "light" | "dark" = "dark",
): Notifications.NotificationContentInput {
  const primary = aggregate.activities[0]!;
  const collapsedSubtitle =
    aggregate.activeCount === 1
      ? truncateText(primary.status, MAX_STATUS_TEXT_LENGTH)
      : `${aggregate.activeCount} active`;
  const body = formatExpandedBody(aggregate);

  return {
    title: truncateText(aggregate.title, MAX_SUMMARY_TEXT_LENGTH),
    subtitle: collapsedSubtitle,
    body,
    sticky: true,
    autoDismiss: false,
    sound: false,
    priority: Notifications.AndroidNotificationPriority.LOW,
    color: agentPhaseAccentColor(primary.phase, colorScheme),
    data: {
      deepLink: primary.deepLink,
      environmentId: primary.environmentId,
      threadId: primary.threadId,
      notificationTag: ONGOING_AGENT_NOTIFICATION_TAG,
      phase: primary.phase,
    },
  };
}

export function ongoingAgentNotificationSummary(aggregate: RelayAgentActivityAggregateState): {
  readonly phase: OngoingAgentNotificationPhase;
  readonly status: string;
  readonly color: string;
} {
  const primary = aggregate.activities[0]!;
  const phase = primary.phase as OngoingAgentNotificationPhase;
  return {
    phase,
    status: agentPhaseStatusLabel(phase),
    color: agentPhaseAccentColor(phase, "dark"),
  };
}

export function ongoingAgentNotificationTrigger(): Notifications.NotificationTriggerInput {
  return { channelId: AGENT_NOTIFICATION_CHANNEL_IDS.running };
}
