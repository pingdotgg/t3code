import Constants from "expo-constants";
import { Platform } from "react-native";
import { supportsAndroidAgentNotifications } from "./androidNotifications";

export function supportsAgentAwarenessPush() {
  return Platform.OS === "android" ? supportsAndroidAgentNotifications() : supportsDirectPush();
}

export function supportsDirectPush() {
  return Platform.OS === "ios" && Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}
