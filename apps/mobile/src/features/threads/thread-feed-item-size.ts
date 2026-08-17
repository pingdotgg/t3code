import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";

// These rows are pure timeline chrome whose rendered height is independent of
// their content. Content-driven rows must be measured by LegendList: returning
// a fixed size makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 56;
const WORK_GROUP_TOGGLE_HEIGHT = 36;
const WORKING_ROW_VERTICAL_EXTRAS = 24;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
  baseFontSize: number,
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
      return WORK_GROUP_TOGGLE_HEIGHT;
    case "working":
      return (
        WORKING_ROW_VERTICAL_EXTRAS +
        scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.label, baseFontSize)
      );
    case "activity-group":
    case "message":
      return undefined;
  }
}
