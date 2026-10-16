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
): Promise<true | string> {
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  if (!permission.granted) return `notification permission ${permission.status}`;
  await Notifications.dismissAllNotificationsAsync();

  if (Platform.OS === "android") {
    return (
      showAndroidShowcaseAgentActivity(showcaseAndroidActivityData(activity, now)) ||
      "native showShowcaseActivity missing"
    );
  }
  if (Platform.OS !== "ios") return `unsupported platform ${Platform.OS}`;

  await Promise.all(getAgentLiveActivities().map((existing) => existing.end("immediate")));
  // ActivityKit only starts activities while the app is foreground, which
  // holds here: the runner locks the device after the scene reports ready.
  return startAgentLiveActivity(activity) !== null || "Live Activity did not start";
}
