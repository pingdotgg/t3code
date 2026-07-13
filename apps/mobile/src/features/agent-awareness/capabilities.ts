import Constants from "expo-constants";

export function supportsAgentAwarenessPush() {
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}
