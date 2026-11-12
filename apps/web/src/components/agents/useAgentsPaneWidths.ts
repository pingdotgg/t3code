import type { CSSProperties } from "react";

import { useElementWidth } from "../../hooks/useElementWidth";
import { useResizableWidth } from "../../hooks/useResizableWidth";

/** The agent rail's fixed width; agents.css sizes `.agents-filters` from the same value. */
export const AGENTS_RAIL_WIDTH = 88;
export const AGENTS_THREADS_PANE = { min: 280, default: 360, max: 720 } as const;
/** The selected chat beside the panes stays readable; the thread list yields first. */
const AGENTS_CHAT_MIN_WIDTH = 420;

/** The thread list's upper bound beside the rail and the minimum chat, never below its minimum. */
export function resolveAgentsThreadsMaxWidth(workspaceWidth: number | null) {
  if (workspaceWidth === null) return AGENTS_THREADS_PANE.max;
  return Math.max(
    AGENTS_THREADS_PANE.min,
    Math.min(AGENTS_THREADS_PANE.max, workspaceWidth - AGENTS_RAIL_WIDTH - AGENTS_CHAT_MIN_WIDTH),
  );
}

/**
 * Device-local width for the thread list. It persists on drag end and is re-clamped
 * (without overwriting the saved width) when the window narrows.
 */
export function useAgentsPaneWidths() {
  const [attachWorkspace, workspaceWidth] = useElementWidth<HTMLElement>();
  const threads = useResizableWidth({
    storageKey: "t3code:agents:threads-width",
    defaultWidth: AGENTS_THREADS_PANE.default,
    minWidth: AGENTS_THREADS_PANE.min,
    maxWidth: resolveAgentsThreadsMaxWidth(workspaceWidth),
    edge: "right",
  });
  return {
    attachWorkspace,
    paneStyle: {
      "--agents-rail-width": `${AGENTS_RAIL_WIDTH}px`,
      "--agents-threads-width": `${threads.width}px`,
    } as CSSProperties,
    threadsHandlers: threads.handlers,
  };
}
