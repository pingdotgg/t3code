import { Platform } from "react-native";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

// Content-driven rows must be measured by LegendList: returning a fixed size
// makes the list skip native measurement entirely.
const INTERACTIVE_ROW_HEIGHT = Platform.OS === "android" ? 48 : 44;
const TURN_FOLD_HEIGHT = INTERACTIVE_ROW_HEIGHT + 4.5;
const WORK_GROUP_TOGGLE_HEIGHT = INTERACTIVE_ROW_HEIGHT + 3.5;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
      return WORK_GROUP_TOGGLE_HEIGHT;
    case "activity-group":
    case "message":
      return undefined;
  }
}
