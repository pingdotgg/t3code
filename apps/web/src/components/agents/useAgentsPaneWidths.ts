import type { CSSProperties } from "react";

import { useElementWidth } from "../../hooks/useElementWidth";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useResizableWidth } from "../../hooks/useResizableWidth";

export const AGENTS_PROFILES_PANE = { min: 200, default: 240, max: 420 } as const;
export const AGENTS_THREADS_PANE = { min: 280, default: 360, max: 720 } as const;
/** The selected chat beside the panes stays readable; the panes yield first. */
const AGENTS_CHAT_MIN_WIDTH = 420;

/**
 * Upper bounds for the Agents board's left panes in a workspace of the given width.
 * Profiles leave room for the minimum thread list and chat; threads take what
 * the profiles pane and chat leave over. Never below each pane's minimum.
 */
export function resolveAgentsPaneMaxWidths(input: {
  workspaceWidth: number | null;
  profilesWidth: number;
  profilesVisible: boolean;
}) {
  if (input.workspaceWidth === null) {
    return { profiles: AGENTS_PROFILES_PANE.max, threads: AGENTS_THREADS_PANE.max };
  }
  const available = input.workspaceWidth - AGENTS_CHAT_MIN_WIDTH;
  return {
    profiles: Math.max(
      AGENTS_PROFILES_PANE.min,
      Math.min(AGENTS_PROFILES_PANE.max, available - AGENTS_THREADS_PANE.min),
    ),
    threads: Math.max(
      AGENTS_THREADS_PANE.min,
      Math.min(
        AGENTS_THREADS_PANE.max,
        available - (input.profilesVisible ? input.profilesWidth : 0),
      ),
    ),
  };
}

/**
 * Device-local widths for the profiles and threads panes. Each persists on drag end
 * and is re-clamped (without overwriting the saved width) when the window narrows.
 */
export function useAgentsPaneWidths() {
  const [attachWorkspace, workspaceWidth] = useElementWidth<HTMLElement>();
  // Matches agents.css: the profiles pane is a column only from 1024px up.
  const profilesVisible = useMediaQuery("lg");
  const profilesMax = resolveAgentsPaneMaxWidths({
    workspaceWidth,
    profilesWidth: 0,
    profilesVisible,
  }).profiles;
  const profiles = useResizableWidth({
    storageKey: "t3code:agents:profiles-width",
    defaultWidth: AGENTS_PROFILES_PANE.default,
    minWidth: AGENTS_PROFILES_PANE.min,
    maxWidth: profilesMax,
    edge: "right",
  });
  const threadsMax = resolveAgentsPaneMaxWidths({
    workspaceWidth,
    profilesWidth: profiles.width,
    profilesVisible,
  }).threads;
  const threads = useResizableWidth({
    storageKey: "t3code:agents:threads-width",
    defaultWidth: AGENTS_THREADS_PANE.default,
    minWidth: AGENTS_THREADS_PANE.min,
    maxWidth: threadsMax,
    edge: "right",
  });
  return {
    attachWorkspace,
    paneStyle: {
      "--agents-profiles-width": `${profiles.width}px`,
      "--agents-threads-width": `${threads.width}px`,
    } as CSSProperties,
    profilesHandlers: profiles.handlers,
    threadsHandlers: threads.handlers,
  };
}
