import type { PreviewSessionSnapshot } from "@t3tools/contracts";

import type { ThreadPreviewState } from "../../previewStateStore";

/** The thread's active browser tab, else the one updated most recently. */
export function selectTargetSession(
  state: Pick<ThreadPreviewState, "sessions" | "activeTabId">,
): PreviewSessionSnapshot | null {
  const active = state.activeTabId ? state.sessions[state.activeTabId] : undefined;
  if (active) return active;
  let latest: PreviewSessionSnapshot | null = null;
  for (const session of Object.values(state.sessions)) {
    if (latest === null || session.updatedAt > latest.updatedAt) latest = session;
  }
  return latest;
}

export function targetSessionUrl(session: PreviewSessionSnapshot): string | null {
  return session.navStatus._tag === "Idle" ? null : session.navStatus.url;
}
