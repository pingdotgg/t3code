/**
 * Pure half of "jump to transcript": locating an agent-run row inside the
 * virtualized timeline.
 *
 * The row is found by index rather than by DOM query, because a run that is
 * scrolled out of the LegendList window has no element to query — a DOM-only
 * jump silently does nothing exactly when the user needs it most.
 */

import type { MessagesTimelineRow } from "./MessagesTimeline.logic.ts";

/** One-shot WAAPI flash; never a loop, so it cannot repaint continuously. */
export const AGENT_RUN_FLASH_DURATION_MS = 1400;

/** Frames to keep re-querying for the row element after an animated scroll. */
export const AGENT_RUN_FLASH_MAX_FRAMES = 40;

export function findAgentRunRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  taskId: string,
): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row && row.kind === "agent-run" && row.run.taskId === taskId) {
      return index;
    }
  }
  return -1;
}

/**
 * Quoted attribute selector. `CSS.escape` is deliberately not used: it is a DOM
 * global this module must stay free of, and a quoted attribute value only needs
 * backslashes and quotes escaped.
 */
export function agentRunRowSelector(taskId: string): string {
  const escaped = taskId.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `[data-agent-run="${escaped}"]`;
}
