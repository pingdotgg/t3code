import type { MessagesTimelineRow } from "./MessagesTimeline.logic-04-timeline.ts";
import {
  messageIsSteer,
  timelineRowIsOwnUserMessage,
  timelineRowIsWorkLog,
} from "./MessagesTimeline.logic-03-derive.ts";

/**
 * Marks consecutive work-log rows as continuing and links runs of the user's own messages, so the
 * timeline can render them as one bubble.
 */
export function groupOwnUserMessages(
  rows: ReadonlyArray<MessagesTimelineRow>,
): MessagesTimelineRow[] {
  return rows.map((row, index) => {
    if (timelineRowIsWorkLog(row) && timelineRowIsWorkLog(rows[index + 1])) {
      return { ...row, continuesWorkLog: true };
    }
    if (!timelineRowIsOwnUserMessage(row)) return row;
    const previous = rows[index - 1];
    const groupedWithNext = timelineRowIsOwnUserMessage(rows[index + 1]);
    const groupedWithPrevious = timelineRowIsOwnUserMessage(previous);
    const continuesSteer =
      groupedWithPrevious && messageIsSteer(row.message) && messageIsSteer(previous.message);
    if (!groupedWithNext && !groupedWithPrevious) return row;
    return { ...row, groupedWithNext, groupedWithPrevious, continuesSteer };
  });
}
