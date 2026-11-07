import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import type { AgentActivityProps } from "../../widgets/AgentActivity";
import {
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "../agent-awareness/agentLiveActivity";
import { showAndroidShowcaseAgentActivity } from "../agent-awareness/androidNotifications";
import { showcaseAndroidActivityData } from "./showcaseAgentActivity";

export async function stageShowcaseAgentActivity(
  activity: AgentActivityProps,
  now: number,
  // A newer request may replace this one while it awaits; it must not start after that.
  isCancelled: () => boolean,
): Promise<true | string> {
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  if (!permission.granted) return `notification permission ${permission.status}`;
  await Notifications.dismissAllNotificationsAsync();
  if (isCancelled()) return "replaced by a newer request";

  if (Platform.OS === "android") {
    return (
      showAndroidShowcaseAgentActivity(showcaseAndroidActivityData(activity, now)) ||
      "native showShowcaseActivity missing"
    );
  }
  if (Platform.OS !== "ios") return `unsupported platform ${Platform.OS}`;

  // A stale fixture is staged with a staleDate that passes almost at once, as a silent relay would leave it.
  const staleDate = activity.activities.some((row) => row.phase === "stale")
    ? new Date(now + 2_000)
    : undefined;
  await Promise.all(getAgentLiveActivities().map((existing) => existing.end("immediate")));
  if (isCancelled()) return "replaced by a newer request";
  // ActivityKit needs foreground startup; the runner locks only after this scene is ready.
  return startAgentLiveActivity(activity, staleDate) !== null || "Live Activity did not start";
}
