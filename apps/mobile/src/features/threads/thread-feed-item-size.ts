import type { ThreadFeedEntry } from "../../lib/threadActivity";

// These rows are pure timeline chrome whose rendered height is independent of
// their content. Content-driven rows must be measured by LegendList: returning
// a fixed size makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 56;
const WORK_GROUP_TOGGLE_HEIGHT = 36;

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
