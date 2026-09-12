import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";
import { readThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { openPreviewSession } from "./openPreviewSession";

const pendingRecentBrowserThreads = new Set<string>();

/** Creates a new browser tab. Reopening an existing tab is a separate UI action. */
export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  /** Omit to use the configured default profile. */
  readonly profileId?: string | undefined;
  readonly url?: string | undefined;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

/** Reuses the most recently visited tab, or restores its URL after it was closed. */
export async function openRecentBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const state = readThreadPreviewState(input.threadRef);
  const url = state.recentlySeenUrls[0];
  const existing = url
    ? Object.values(state.sessions).find(
        (session) => session.navStatus._tag !== "Idle" && session.navStatus.url === url,
      )
    : state.activeTabId
      ? state.sessions[state.activeTabId]
      : undefined;
  if (existing) {
    useRightPanelStore.getState().openBrowser(input.threadRef, existing.tabId);
    return AsyncResult.success(undefined);
  }
  const key = scopedThreadKey(input.threadRef);
  if (pendingRecentBrowserThreads.has(key)) return AsyncResult.success(undefined);
  pendingRecentBrowserThreads.add(key);
  try {
    return await addBrowserSurface({ ...input, url });
  } finally {
    pendingRecentBrowserThreads.delete(key);
  }
}
