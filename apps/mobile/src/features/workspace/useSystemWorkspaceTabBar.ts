import { Platform } from "react-native";

/** UIKit owns workspace tab navigation on every iOS size class. */
export function useSystemWorkspaceTabBar() {
  return Platform.OS === "ios";
}
