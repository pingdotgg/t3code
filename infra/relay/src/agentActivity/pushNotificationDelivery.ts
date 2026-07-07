import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { RelayAgentAwarenessPreferences as RelayAgentAwarenessPreferencesSchema } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

const decodeRelayAgentAwarenessPreferencesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferencesSchema),
);

function parsePreferences(value: string): RelayAgentAwarenessPreferences | null {
  return Option.getOrNull(decodeRelayAgentAwarenessPreferencesJson(value));
}

export function notificationForAggregate(input: {
  readonly preferencesJson: string;
  readonly pushToken: string | null;
  readonly aggregate: RelayAgentActivityAggregateState | null;
}): ApnsNotificationPayload | null {
  if (!input.pushToken || input.aggregate === null) {
    return null;
  }
  const preferences = parsePreferences(input.preferencesJson);
  if (!preferences?.notificationsEnabled) {
    return null;
  }
  const activity = input.aggregate.activities[0];
  if (!activity) {
    return null;
  }
  const enabled =
    (activity.phase === "waiting_for_approval" && preferences.notifyOnApproval) ||
    (activity.phase === "waiting_for_input" && preferences.notifyOnInput) ||
    (activity.phase === "completed" && preferences.notifyOnCompletion) ||
    (activity.phase === "failed" && preferences.notifyOnFailure);
  if (!enabled) {
    return null;
  }
  return {
    title: activity.threadTitle,
    body: `${activity.status}: ${activity.projectTitle}`,
    environmentId: activity.environmentId,
    threadId: activity.threadId,
    deepLink: activity.deepLink,
  };
}

export function fcmChannelIdForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "agent_approval";
    case "waiting_for_input":
      return "agent_input";
    case "failed":
      return "agent_failed";
    case "completed":
      return "agent_completed";
    case "running":
    case "starting":
    case "stale":
      return "agent_running";
  }
}
