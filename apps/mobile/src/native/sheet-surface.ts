import { Platform } from "react-native";

export function formSheetDetents(initialDetent: number, androidExpandedDetent = 0.92) {
  // Duo moves the status bar above the sheet only at the maximum native detent.
  return [initialDetent, Platform.OS === "ios" ? 1 : androidExpandedDetent];
}
