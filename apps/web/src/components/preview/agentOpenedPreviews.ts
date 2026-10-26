import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import { getClientSettings } from "../../hooks/useSettings";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import {
  onPreviewSessionsChanged,
  onServerTabsRevealed,
  type ThreadPreviewState,
} from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { readEnvironmentSupportsServerBrowser } from "../../state/entities";

/**
 * Shows browsers an agent or another client revealed for a thread: floating
 * over chat, or focusing an existing panel tab when the reveal is forced.
 */
export function revealServerTabs(
  threadRef: ScopedThreadRef,
  sessions: ReadonlyArray<PreviewSessionSnapshot>,
  options: { readonly autoShowFloatingPreview: boolean },
): void {
  if (!readEnvironmentSupportsServerBrowser(threadRef.environmentId)) return;
  for (const session of sessions) {
    const force = session.revealRequest?.force === true;
    if (!options.autoShowFloatingPreview && !force) continue;
    const surface = useRightPanelStore
      .getState()
      .byThreadKey[scopedThreadKey(threadRef)]?.surfaces.find(
        (surface) => surface.kind === "preview" && surface.resourceId === session.tabId,
      );
    if (surface && force) {
      useRightPanelStore.getState().activateSurface(threadRef, surface.id);
    } else if (!surface) {
      usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(session.tabId));
    }
  }
}

/**
 * Keeps a thread's browser panel tabs and floating browser in step with its
 * preview sessions. Server-hosted sessions are only complete once the first
 * list has loaded; before that, a missing session is not a closed one.
 */
export function followPreviewSessions(threadRef: ScopedThreadRef, state: ThreadPreviewState): void {
  if (readEnvironmentSupportsServerBrowser(threadRef.environmentId) && !state.listLoaded) return;
  const sessions = Object.values(state.sessions);
  useRightPanelStore.getState().reconcileBrowserSurfaces(
    threadRef,
    sessions.map((session) => session.tabId),
    new Set(
      sessions
        .filter((session) => session.runtime === "server" && session.reveal === false)
        .map((session) => session.tabId),
    ),
  );
  const miniPlayer = usePreviewMiniPlayerStore.getState();
  const source = miniPlayer.byThreadKey[scopedThreadKey(threadRef)]?.source;
  if (source?.kind === "browser" && !state.sessions[source.tabId]) miniPlayer.close(threadRef);
}

let started = false;

/** Follows every thread's browser previews for the life of the page, not just the open thread's. */
export function startAgentOpenedPreviews(): void {
  if (started) return;
  started = true;
  onPreviewSessionsChanged(followPreviewSessions);
  onServerTabsRevealed((threadRef, sessions) =>
    revealServerTabs(threadRef, sessions, {
      autoShowFloatingPreview: getClientSettings().browserAutoShowFloatingPreview,
    }),
  );
}
