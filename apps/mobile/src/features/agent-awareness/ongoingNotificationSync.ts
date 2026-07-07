import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { ensureAgentNotificationChannels } from "./notificationChannels";
import {
  buildOngoingAgentNotificationContent,
  ongoingAgentNotificationTrigger,
  ONGOING_AGENT_NOTIFICATION_TAG,
  shouldShowOngoingAgentNotification,
} from "./ongoingNotificationModel";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";

let handlerInstalled = false;
let lastPublishedFingerprint: string | null = null;
let ongoingNotificationVisible = false;

function installOngoingNotificationHandler(): void {
  if (handlerInstalled || Platform.OS !== "android") {
    return;
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  handlerInstalled = true;
}

function fingerprintAggregate(aggregate: RelayAgentActivityAggregateState): string {
  return JSON.stringify({
    activeCount: aggregate.activeCount,
    updatedAt: aggregate.updatedAt,
    activities: aggregate.activities.map((row) => ({
      environmentId: row.environmentId,
      threadId: row.threadId,
      phase: row.phase,
      status: row.status,
      updatedAt: row.updatedAt,
    })),
  });
}

export async function clearOngoingAgentNotification(): Promise<void> {
  if (Platform.OS !== "android" || !ongoingNotificationVisible) {
    lastPublishedFingerprint = null;
    return;
  }

  await Notifications.dismissNotificationAsync(ONGOING_AGENT_NOTIFICATION_TAG);
  ongoingNotificationVisible = false;
  lastPublishedFingerprint = null;
}

export async function syncOngoingAgentNotification(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly notificationsEnabled: boolean;
  readonly colorScheme?: "light" | "dark";
}): Promise<void> {
  if (Platform.OS !== "android" || !input.notificationsEnabled) {
    await clearOngoingAgentNotification();
    return;
  }

  installOngoingNotificationHandler();
  await ensureAgentNotificationChannels();

  if (!shouldShowOngoingAgentNotification(input.aggregate)) {
    await clearOngoingAgentNotification();
    return;
  }

  const fingerprint = fingerprintAggregate(input.aggregate);
  if (fingerprint === lastPublishedFingerprint) {
    return;
  }

  await Notifications.scheduleNotificationAsync({
    identifier: ONGOING_AGENT_NOTIFICATION_TAG,
    content: buildOngoingAgentNotificationContent(input.aggregate, input.colorScheme ?? "dark"),
    trigger: ongoingAgentNotificationTrigger(),
  });
  ongoingNotificationVisible = true;
  lastPublishedFingerprint = fingerprint;
}

export function resetOngoingAgentNotificationSyncForTests(): void {
  handlerInstalled = false;
  lastPublishedFingerprint = null;
  ongoingNotificationVisible = false;
}
