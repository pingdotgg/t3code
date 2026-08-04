import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

import type { ThreadNotificationEvent } from "./thread-notification-reducer";

export const ANDROID_AGENT_NOTIFICATION_CHANNEL_ID = "agent-activity";

export type AndroidNotificationPermission =
  | { readonly type: "unsupported" }
  | { readonly type: "granted" }
  | { readonly type: "denied"; readonly canAskAgain: boolean };

export async function ensureAndroidAgentNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(ANDROID_AGENT_NOTIFICATION_CHANNEL_ID, {
    name: "Agent activity",
    description: "Task completions and requests that need your attention",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    vibrationPattern: [0, 200, 100, 200],
    enableVibrate: true,
    showBadge: true,
  });
}

export async function getAndroidAgentNotificationPermission(): Promise<AndroidNotificationPermission> {
  if (Platform.OS !== "android") return { type: "unsupported" };
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted
    ? { type: "granted" }
    : { type: "denied", canAskAgain: permission.canAskAgain };
}

export async function requestAndroidAgentNotificationPermission(): Promise<AndroidNotificationPermission> {
  if (Platform.OS !== "android") return { type: "unsupported" };
  await ensureAndroidAgentNotificationChannel();
  const existing = await getAndroidAgentNotificationPermission();
  if (existing.type !== "denied" || !existing.canAskAgain) return existing;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted
    ? { type: "granted" }
    : { type: "denied", canAskAgain: requested.canAskAgain };
}

export function androidThreadNotificationContent(event: ThreadNotificationEvent): {
  readonly title: string;
  readonly body: string;
} {
  switch (event.kind) {
    case "completed":
      return { title: "Task completed", body: event.threadTitle };
    case "failed":
      return { title: "Task failed", body: `${event.threadTitle} needs attention.` };
    case "approval-required":
      return { title: "Approval required", body: event.threadTitle };
    case "user-input-required":
      return { title: "Input required", body: event.threadTitle };
  }
}

export async function presentAndroidThreadNotification(
  event: ThreadNotificationEvent,
): Promise<void> {
  if (Platform.OS !== "android" || AppState.currentState === "active") return;
  await ensureAndroidAgentNotificationChannel();
  const permission = await getAndroidAgentNotificationPermission();
  if (permission.type !== "granted") return;
  const content = androidThreadNotificationContent(event);
  const deepLink = `/threads/${encodeURIComponent(event.environmentId)}/${encodeURIComponent(event.threadId)}`;
  await Notifications.scheduleNotificationAsync({
    identifier: event.id,
    content: {
      ...content,
      sound: "default",
      priority: Notifications.AndroidNotificationPriority.HIGH,
      data: {
        deepLink,
        environmentId: event.environmentId,
        threadId: event.threadId,
        eventKind: event.kind,
      },
    },
    trigger: { channelId: ANDROID_AGENT_NOTIFICATION_CHANNEL_ID },
  });
}
