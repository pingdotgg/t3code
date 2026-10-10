import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import type { AgentActivityProps } from "../../widgets/AgentActivity";
import {
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "../agent-awareness/agentLiveActivity";
import { showAndroidShowcaseAgentActivity } from "../agent-awareness/androidNotifications";
import { showcaseAndroidActivityData } from "./showcaseAgentActivity";

/**
 * Puts the staged agent activity on screen for the capture runner, which then
 * locks the simulator (iOS) or opens the notification shade (Android).
 * Resolves true once shown, otherwise the reason it could not be, so the
 * caller can retry and report.
 */
export async function stageShowcaseAgentActivity(
  activity: AgentActivityProps,
  now: number,
): Promise<true | string> {
  // The runner answers the iOS prompt and pre-grants Android's, so this only
  // settles the permission the runner's alert delivery depends on.
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  if (!permission.granted) return `notification permission ${permission.status}`;
  // A previous appearance's pass left its alert delivered; it would stack
  // under the new one.
  await Notifications.dismissAllNotificationsAsync();

  if (Platform.OS === "android") {
    return (
      showAndroidShowcaseAgentActivity(showcaseAndroidActivityData(activity, now)) ||
      "native showShowcaseActivity missing"
    );
  }
  if (Platform.OS !== "ios") return `unsupported platform ${Platform.OS}`;

  // A retried or revisited scene must not stack a second card.
  await Promise.all(getAgentLiveActivities().map((existing) => existing.end("immediate")));
  // ActivityKit only starts activities while the app is foreground, which
  // holds here: the runner locks the device after the scene reports ready.
  return startAgentLiveActivity(activity) !== null || "Live Activity did not start";
}
