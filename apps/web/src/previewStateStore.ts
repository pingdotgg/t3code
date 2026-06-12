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
  controller: "human" | "agent" | "none";
}

export interface ThreadPreviewState {
  snapshot: PreviewSessionSnapshot | null;
  sessions: Record<string, PreviewSessionSnapshot>;
  activeTabId: string | null;
  /** Bridge state takes precedence over `snapshot` for nav button enablement. */
  desktopOverlay: DesktopPreviewOverlay | null;
  desktopByTabId: Record<string, DesktopPreviewOverlay>;
  /** Recently-visited URLs surfaced in the empty state. */
  recentlySeenUrls: string[];
}

const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  snapshot: null,
  sessions: {},
  activeTabId: null,
  desktopOverlay: null,
  desktopByTabId: {},
  recentlySeenUrls: [] as string[],
});

export interface PreviewStateStoreState {
  byThreadKey: Record<string, ThreadPreviewState>;
  applyServerEvent: (ref: ScopedThreadRef, event: PreviewEvent) => void;
  applyServerSnapshot: (ref: ScopedThreadRef, snapshot: PreviewSessionSnapshot | null) => void;
  applyDesktopState: (
    ref: ScopedThreadRef,
    tabId: string,
    overlay: DesktopPreviewOverlay | null,
  ) => void;
  setActiveTab: (ref: ScopedThreadRef, tabId: string) => void;
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
            const sessions = { ...current.sessions, [snapshot.tabId]: snapshot };
            const activeTabId = event.type === "opened" ? snapshot.tabId : current.activeTabId;
            const activeSnapshot = sessions[activeTabId ?? snapshot.tabId] ?? snapshot;
            return {
              ...current,
              sessions,
              activeTabId: activeTabId ?? snapshot.tabId,
              snapshot: activeSnapshot,
              desktopOverlay: current.desktopByTabId[activeSnapshot.tabId] ?? null,
              recentlySeenUrls,
            };
          });
          break;
        case "failed":
          nextByThread = updateThread(state, threadKey, (current) => {
            const existing = current.sessions[event.tabId];
            if (!existing) return current;
            const failedSnapshot = {
              ...existing,
              navStatus: {
                _tag: "LoadFailed" as const,
                url: event.url,
                title: event.title,
                code: event.code,
                description: event.description,
              },
              updatedAt: event.createdAt,
            };
            const sessions = { ...current.sessions, [event.tabId]: failedSnapshot };
            return {
              ...current,
              sessions,
              snapshot: current.activeTabId === event.tabId ? failedSnapshot : current.snapshot,
            };
          });
          break;
        case "closed":
          nextByThread = updateThread(state, threadKey, (current) => {
            if (!current.sessions[event.tabId]) return current;
            const { [event.tabId]: _closed, ...sessions } = current.sessions;
            const { [event.tabId]: _desktop, ...desktopByTabId } = current.desktopByTabId;
            const nextSnapshot =
              Object.values(sessions)
                .toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                .at(-1) ?? null;
            const activeTabId =
              current.activeTabId === event.tabId
                ? (nextSnapshot?.tabId ?? null)
                : current.activeTabId;
            const snapshot = activeTabId ? (sessions[activeTabId] ?? nextSnapshot) : nextSnapshot;
            return {
              ...current,
              sessions,
              desktopByTabId,
              activeTabId: snapshot?.tabId ?? null,
              snapshot,
              desktopOverlay: snapshot ? (desktopByTabId[snapshot.tabId] ?? null) : null,
            };
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
        if (!snapshot) {
          return {
            ...current,
            snapshot: null,
            sessions: {},
            activeTabId: null,
            desktopOverlay: null,
            desktopByTabId: {},
          };
        }
        const recentlySeenUrls =
          snapshot && snapshot.navStatus._tag !== "Idle"
            ? dedupeRecentUrls(current.recentlySeenUrls, snapshot.navStatus.url)
            : current.recentlySeenUrls;
        return {
          ...current,
          snapshot,
          sessions: { ...current.sessions, [snapshot.tabId]: snapshot },
          activeTabId: snapshot.tabId,
          desktopOverlay: current.desktopByTabId[snapshot.tabId] ?? null,
          recentlySeenUrls,
        };
      });
      return { byThreadKey: nextByThread };
    }),
  applyDesktopState: (ref, tabId, overlay) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const nextByThread = updateThread(state, threadKey, (current) => {
        const desktopByTabId = { ...current.desktopByTabId };
        if (overlay) desktopByTabId[tabId] = overlay;
        else delete desktopByTabId[tabId];
        return {
          ...current,
          desktopByTabId,
          desktopOverlay: current.activeTabId === tabId ? overlay : current.desktopOverlay,
        };
      });
      return { byThreadKey: nextByThread };
    }),
  setActiveTab: (ref, tabId) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const nextByThread = updateThread(state, threadKey, (current) => {
        const snapshot = current.sessions[tabId];
        if (!snapshot || current.activeTabId === tabId) return current;
        return {
          ...current,
          activeTabId: tabId,
          snapshot,
          desktopOverlay: current.desktopByTabId[tabId] ?? null,
        };
      });
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
