import { htmlRenderFrameHeight, type HtmlRenderReference } from "@t3tools/shared/htmlRender";

import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

// These rows are pure timeline chrome whose rendered height is independent of
// their content. Content-driven rows must be measured by LegendList: returning
// a fixed size makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = 42;
const WORK_GROUP_TOGGLE_HEIGHT = THREAD_WORK_ROW_MIN_HEIGHT;

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

export const HTML_RENDER_ROW_BOTTOM_MARGIN = 8;

/**
 * The feed's fixed height for an HTML render row. Shown, it is the frame's
 * height plus spacing; the page's content never sizes it. Minimized, it is one
 * work-log row plus the same spacing. `workRowHeight` is undefined when text
 * scaling can make that row taller, and the minimized row is then measured.
 */
export function resolveHtmlRenderRowHeight(input: {
  readonly render: HtmlRenderReference;
  readonly frameWidth: number;
  readonly collapsed: boolean;
  readonly workRowHeight: number | undefined;
}): number | undefined {
  if (!input.collapsed) {
    return htmlRenderFrameHeight(input.render, input.frameWidth) + HTML_RENDER_ROW_BOTTOM_MARGIN;
  }
  return input.workRowHeight === undefined
    ? undefined
    : input.workRowHeight + HTML_RENDER_ROW_BOTTOM_MARGIN;
}
