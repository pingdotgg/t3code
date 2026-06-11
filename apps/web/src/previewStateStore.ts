/**
 * Per-thread preview UI state.
 *
 * Single-tab model: one snapshot per thread, mirrored two ways:
 *   - `snapshot` is the server-authoritative URL/title/load-status, replayed
 *     on WS reconnect so the panel survives backend restarts.
 *   - `desktopOverlay` is low-latency state from the local <webview>
 *     (canGoBack/canGoForward/visible/zoom/loading), used by the chrome row's
 *     button enablement.
 *
 * The schema-level `tabId` exists because the server still keys sessions by
 * `(threadId, tabId)`; the client just always tracks one and ignores the rest.
 */
import { scopedThreadKey } from "@t3tools/client-runtime";
import {
  type PreviewEvent,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

import { PREVIEW_RECENT_URL_LIMIT } from "./components/preview/previewConstants";

export interface DesktopPreviewOverlay {
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  zoomFactor: number;
}

export interface ThreadPreviewState {
  snapshot: PreviewSessionSnapshot | null;
  /** Bridge state takes precedence over `snapshot` for nav button enablement. */
  desktopOverlay: DesktopPreviewOverlay | null;
  /** Recently-visited URLs surfaced in the empty state. */
  recentlySeenUrls: string[];
}

const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  snapshot: null,
  desktopOverlay: null,
  recentlySeenUrls: [] as string[],
});

export interface PreviewStateStoreState {
  byThreadKey: Record<string, ThreadPreviewState>;
  applyServerEvent: (ref: ScopedThreadRef, event: PreviewEvent) => void;
  applyServerSnapshot: (ref: ScopedThreadRef, snapshot: PreviewSessionSnapshot | null) => void;
  applyDesktopState: (ref: ScopedThreadRef, overlay: DesktopPreviewOverlay | null) => void;
  rememberUrl: (ref: ScopedThreadRef, url: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const ensureState = (
  byThreadKey: Record<string, ThreadPreviewState>,
  threadKey: string,
): ThreadPreviewState => byThreadKey[threadKey] ?? EMPTY_THREAD_PREVIEW_STATE;

const updateThread = (
  state: PreviewStateStoreState,
  threadKey: string,
  updater: (current: ThreadPreviewState) => ThreadPreviewState,
): PreviewStateStoreState["byThreadKey"] => {
  const current = ensureState(state.byThreadKey, threadKey);
  const next = updater(current);
  if (next === current) return state.byThreadKey;
  return { ...state.byThreadKey, [threadKey]: next };
};

const removeThreadKey = (
  byThreadKey: Record<string, ThreadPreviewState>,
  threadKey: string,
): Record<string, ThreadPreviewState> => {
  if (!(threadKey in byThreadKey)) return byThreadKey;
  const { [threadKey]: _removed, ...rest } = byThreadKey;
  return rest;
};

const dedupeRecentUrls = (existing: string[], url: string): string[] => {
  const next = [url, ...existing.filter((entry) => entry !== url)];
  return next.slice(0, PREVIEW_RECENT_URL_LIMIT);
};

export const usePreviewStateStore = create<PreviewStateStoreState>()((set) => ({
  byThreadKey: {},
  applyServerEvent: (ref, event) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      let nextByThread = state.byThreadKey;
      switch (event.type) {
        case "opened":
        case "navigated":
          nextByThread = updateThread(state, threadKey, (current) => {
            const snapshot = event.snapshot;
            const recentlySeenUrls =
              snapshot.navStatus._tag === "Idle"
                ? current.recentlySeenUrls
                : dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url);
            return { ...current, snapshot, recentlySeenUrls };
          });
          break;
        case "failed":
          nextByThread = updateThread(state, threadKey, (current) => {
            if (!current.snapshot || current.snapshot.tabId !== event.tabId) return current;
            return {
              ...current,
              snapshot: {
                ...current.snapshot,
                navStatus: {
                  _tag: "LoadFailed",
                  url: event.url,
                  title: event.title,
                  code: event.code,
                  description: event.description,
                },
                updatedAt: event.createdAt,
              },
            };
          });
          break;
        case "closed":
          nextByThread = updateThread(state, threadKey, (current) => {
            // Only clear if the closed tab is the one we were tracking; the
            // server may have multiple tabs per thread but we only render one.
            if (current.snapshot && current.snapshot.tabId !== event.tabId) return current;
            return { ...current, snapshot: null, desktopOverlay: null };
          });
          break;
      }
      return { byThreadKey: nextByThread };
    }),
  applyServerSnapshot: (ref, snapshot) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const nextByThread = updateThread(state, threadKey, (current) => {
        if (!snapshot && current.snapshot === null) return current;
        const recentlySeenUrls =
          snapshot && snapshot.navStatus._tag !== "Idle"
            ? dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url)
            : current.recentlySeenUrls;
        return { ...current, snapshot, recentlySeenUrls };
      });
      return { byThreadKey: nextByThread };
    }),
  applyDesktopState: (ref, overlay) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const nextByThread = updateThread(state, threadKey, (current) => ({
        ...current,
        desktopOverlay: overlay,
      }));
      return { byThreadKey: nextByThread };
    }),
  rememberUrl: (ref, url) =>
    set((state) => {
      if (url.trim().length === 0) return state;
      const threadKey = scopedThreadKey(ref);
      const nextByThread = updateThread(state, threadKey, (current) => ({
        ...current,
        recentlySeenUrls: dedupeRecentUrls(current.recentlySeenUrls, url),
      }));
      return { byThreadKey: nextByThread };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      return { byThreadKey: removeThreadKey(state.byThreadKey, threadKey) };
    }),
}));

export function selectThreadPreviewState(
  byThreadKey: Record<string, ThreadPreviewState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadPreviewState {
  if (!ref) return EMPTY_THREAD_PREVIEW_STATE;
  return ensureState(byThreadKey, scopedThreadKey(ref));
}

export function isPreviewSupportedInRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.desktopBridge?.preview);
}

export const __testing = {
  EMPTY_THREAD_PREVIEW_STATE,
  RECENT_URL_LIMIT: PREVIEW_RECENT_URL_LIMIT,
};
