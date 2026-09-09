import Constants from "expo-constants";
import { Platform } from "react-native";

export function supportsAgentAwarenessPush() {
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

/** Whether this client can actually receive relay-delivered agent awareness
    pushes. APNs registration is iOS-only (see `canRegisterRemoteLiveActivities`
    in remoteRegistration), and personal-team builds ship without the push
    entitlement, so neither can consume anything the environment publishes. */
export function canReceiveAgentAwarenessPush() {
  return Platform.OS === "ios" && supportsAgentAwarenessPush();
}
