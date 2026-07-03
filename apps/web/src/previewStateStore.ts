import {
  type DesktopPreviewTabState,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import { clampPreviewTitle } from "@t3tools/shared/preview";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { readEnvironmentApi } from "./environmentApi";

const MAX_RECENT_PREVIEW_URLS = 12;

export interface ThreadPreviewState {
  readonly sessions: readonly PreviewSessionSnapshot[];
  readonly activeTabId: string | null;
  readonly suppressedTabIds: readonly string[];
  readonly desktopByTabId: Readonly<Record<string, DesktopPreviewTabState>>;
  readonly surfaceByTabId: Readonly<Record<string, PreviewSurfaceRect>>;
  readonly recentlySeenUrls: readonly string[];
}

export interface PreviewSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HostedPreviewSurface {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
  readonly rect: PreviewSurfaceRect;
}

interface PreviewStateStore {
  readonly byThreadKey: Readonly<Record<string, ThreadPreviewState>>;
}

interface UsePreviewSessionOptions {
  readonly onError?: (error: unknown) => void;
}

const EMPTY_THREAD_PREVIEW_STATE: ThreadPreviewState = Object.freeze({
  sessions: Object.freeze([]),
  activeTabId: null,
  suppressedTabIds: Object.freeze([]),
  desktopByTabId: Object.freeze({}),
  surfaceByTabId: Object.freeze({}),
  recentlySeenUrls: Object.freeze([]),
});

const usePreviewStateStore = create<PreviewStateStore>(() => ({
  byThreadKey: {},
}));

function getThreadState(key: string): ThreadPreviewState {
  return usePreviewStateStore.getState().byThreadKey[key] ?? EMPTY_THREAD_PREVIEW_STATE;
}

function updateThreadState(
  ref: ScopedThreadRef,
  updater: (state: ThreadPreviewState) => ThreadPreviewState,
): void {
  const key = scopedThreadKey(ref);
  usePreviewStateStore.setState((state) => ({
    byThreadKey: {
      ...state.byThreadKey,
      [key]: updater(state.byThreadKey[key] ?? EMPTY_THREAD_PREVIEW_STATE),
    },
  }));
}

function withoutSuppressedSessions(
  sessions: readonly PreviewSessionSnapshot[],
  suppressedTabIds: readonly string[],
): readonly PreviewSessionSnapshot[] {
  if (suppressedTabIds.length === 0) {
    return sessions;
  }
  const suppressed = new Set(suppressedTabIds);
  return sessions.filter((session) => !suppressed.has(session.tabId));
}

function withActiveTab(
  state: ThreadPreviewState,
  sessions: readonly PreviewSessionSnapshot[],
): ThreadPreviewState {
  const activeTabId =
    state.activeTabId && sessions.some((session) => session.tabId === state.activeTabId)
      ? state.activeTabId
      : (sessions[0]?.tabId ?? null);

  return {
    ...state,
    sessions,
    activeTabId,
  };
}

function upsertSession(
  sessions: readonly PreviewSessionSnapshot[],
  snapshot: PreviewSessionSnapshot,
): readonly PreviewSessionSnapshot[] {
  const nextSessions = sessions.filter((session) => session.tabId !== snapshot.tabId);
  return [snapshot, ...nextSessions];
}

function removeSession(
  sessions: readonly PreviewSessionSnapshot[],
  tabId: string,
): readonly PreviewSessionSnapshot[] {
  return sessions.filter((session) => session.tabId !== tabId);
}

function rememberUrl(urls: readonly string[], url: string | null | undefined): readonly string[] {
  if (!url) {
    return urls;
  }
  return [url, ...urls.filter((existing) => existing !== url)].slice(0, MAX_RECENT_PREVIEW_URLS);
}

export function getPreviewSnapshotUrl(snapshot: PreviewSessionSnapshot | null): string {
  const status = snapshot?.navStatus;
  if (!status || status._tag === "Idle") {
    return "";
  }
  return status.url;
}

export function getPreviewSnapshotTitle(snapshot: PreviewSessionSnapshot | null): string {
  const status = snapshot?.navStatus;
  if (!status || status._tag === "Idle") {
    return "Browser";
  }
  return status.title || status.url || "Browser";
}

export function desktopPreviewNavStatusToPreviewNavStatus(
  state: DesktopPreviewTabState,
): PreviewNavStatus {
  const fallbackUrl = state.url ?? "";
  const fallbackTitle = clampPreviewTitle(state.title || fallbackUrl);

  switch (state.navStatus.kind) {
    case "loading": {
      const url = state.navStatus.url || fallbackUrl;
      if (!url) {
        return { _tag: "Idle" };
      }
      return {
        _tag: "Loading",
        url,
        title: clampPreviewTitle(state.navStatus.title || fallbackTitle),
      };
    }
    case "success": {
      const url = state.navStatus.url || fallbackUrl;
      if (!url) {
        return { _tag: "Idle" };
      }
      return {
        _tag: "Success",
        url,
        title: clampPreviewTitle(state.navStatus.title || fallbackTitle),
      };
    }
    case "failed": {
      const url = state.navStatus.url || fallbackUrl;
      if (!url) {
        return { _tag: "Idle" };
      }
      return {
        _tag: "LoadFailed",
        url,
        title: clampPreviewTitle(state.navStatus.title || fallbackTitle),
        code: state.navStatus.errorCode,
        description: state.navStatus.errorText,
      };
    }
    case "idle":
      return { _tag: "Idle" };
  }
}

export function readThreadPreviewState(ref: ScopedThreadRef): ThreadPreviewState {
  return getThreadState(scopedThreadKey(ref));
}

export function useThreadPreviewState(ref: ScopedThreadRef): ThreadPreviewState {
  const key = scopedThreadKey(ref);
  return usePreviewStateStore((state) => state.byThreadKey[key] ?? EMPTY_THREAD_PREVIEW_STATE);
}

export function getActivePreviewSnapshot(state: ThreadPreviewState): PreviewSessionSnapshot | null {
  return (
    state.sessions.find((session) => session.tabId === state.activeTabId) ??
    state.sessions[0] ??
    null
  );
}

export function useActivePreviewSessions(): readonly PreviewSessionSnapshot[] {
  const byThreadKey = usePreviewStateStore((state) => state.byThreadKey);
  return useMemo(
    () => Object.values(byThreadKey).flatMap((threadState) => threadState.sessions),
    [byThreadKey],
  );
}

const threadRefByKeyCache = new Map<string, ScopedThreadRef>();

/**
 * Returns a stable {@link ScopedThreadRef} instance for a given thread key.
 * `parseScopedThreadKey` allocates a fresh object each call; reusing one keeps
 * referential identity stable across renders so effects/callbacks keyed on the
 * ref (e.g. the hosted webview's createTab / register effects) don't re-run on
 * every store update.
 */
function stableThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  const cached = threadRefByKeyCache.get(threadKey);
  if (cached) {
    return cached;
  }
  const parsed = parseScopedThreadKey(threadKey);
  if (parsed) {
    threadRefByKeyCache.set(threadKey, parsed);
  }
  return parsed;
}

export function useHostedPreviewSurfaces(): readonly HostedPreviewSurface[] {
  const byThreadKey = usePreviewStateStore((state) => state.byThreadKey);
  return useMemo(
    () =>
      Object.entries(byThreadKey).flatMap(([threadKey, threadState]) => {
        const threadRef = stableThreadRefFromKey(threadKey);
        if (!threadRef) {
          return [];
        }
        return threadState.sessions.flatMap((snapshot) => {
          const rect = threadState.surfaceByTabId[snapshot.tabId];
          return rect ? [{ threadRef, snapshot, rect }] : [];
        });
      }),
    [byThreadKey],
  );
}

export function findPreviewThreadRefByTabId(tabId: string): ScopedThreadRef | null {
  const byThreadKey = usePreviewStateStore.getState().byThreadKey;
  for (const [threadKey, threadState] of Object.entries(byThreadKey)) {
    if (!threadState.sessions.some((session) => session.tabId === tabId)) {
      continue;
    }
    return stableThreadRefFromKey(threadKey);
  }
  return null;
}

export function activatePreviewTab(ref: ScopedThreadRef, tabId: string): void {
  updateThreadState(ref, (state) => {
    if (!state.sessions.some((session) => session.tabId === tabId)) {
      return state;
    }
    return {
      ...state,
      activeTabId: tabId,
    };
  });
}

export function applyPreviewServerSnapshot(
  ref: ScopedThreadRef,
  snapshot: PreviewSessionSnapshot,
): void {
  updateThreadState(ref, (state) => {
    const sessions = upsertSession(state.sessions, snapshot);
    return withActiveTab(
      {
        ...state,
        suppressedTabIds: state.suppressedTabIds.filter((tabId) => tabId !== snapshot.tabId),
        recentlySeenUrls: rememberUrl(state.recentlySeenUrls, getPreviewSnapshotUrl(snapshot)),
      },
      sessions,
    );
  });
}

export function applyPreviewServerSnapshotList(
  ref: ScopedThreadRef,
  sessions: readonly PreviewSessionSnapshot[],
): void {
  updateThreadState(ref, (state) =>
    withActiveTab(
      {
        ...state,
        recentlySeenUrls: sessions.reduce(
          (urls, session) => rememberUrl(urls, getPreviewSnapshotUrl(session)),
          state.recentlySeenUrls,
        ),
      },
      withoutSuppressedSessions(sessions, state.suppressedTabIds),
    ),
  );
}

export function applyPreviewServerEvent(ref: ScopedThreadRef, event: PreviewEvent): void {
  if (event.type === "closed") {
    markPreviewTabClosed(ref, event.tabId);
    return;
  }

  if ("snapshot" in event) {
    applyPreviewServerSnapshot(ref, event.snapshot);
    return;
  }

  updateThreadState(ref, (state) => {
    const current = state.sessions.find((session) => session.tabId === event.tabId);
    if (!current) {
      return state;
    }

    const snapshot: PreviewSessionSnapshot = {
      ...current,
      navStatus: {
        _tag: "LoadFailed",
        url: event.url,
        title: clampPreviewTitle(event.title),
        code: event.code,
        description: event.description,
      },
      updatedAt: event.createdAt,
    };

    return withActiveTab(
      {
        ...state,
        recentlySeenUrls: rememberUrl(state.recentlySeenUrls, event.url),
      },
      upsertSession(state.sessions, snapshot),
    );
  });
}

export function applyPreviewDesktopState(
  ref: ScopedThreadRef,
  desktopState: DesktopPreviewTabState,
): void {
  updateThreadState(ref, (state) => {
    const current = state.sessions.find((session) => session.tabId === desktopState.tabId);
    const sessions = current
      ? upsertSession(state.sessions, {
          ...current,
          navStatus: desktopPreviewNavStatusToPreviewNavStatus(desktopState),
          canGoBack: desktopState.canGoBack,
          canGoForward: desktopState.canGoForward,
          updatedAt: desktopState.updatedAt,
        })
      : state.sessions;

    return withActiveTab(
      {
        ...state,
        desktopByTabId: {
          ...state.desktopByTabId,
          [desktopState.tabId]: desktopState,
        },
        recentlySeenUrls: rememberUrl(state.recentlySeenUrls, desktopState.url),
      },
      sessions,
    );
  });
}

export function rememberPreviewUrl(ref: ScopedThreadRef, url: string): void {
  updateThreadState(ref, (state) => ({
    ...state,
    recentlySeenUrls: rememberUrl(state.recentlySeenUrls, url),
  }));
}

export function markPreviewTabClosed(ref: ScopedThreadRef, tabId: string): void {
  updateThreadState(ref, (state) => {
    const sessions = removeSession(state.sessions, tabId);
    const { [tabId]: _closedDesktopState, ...desktopByTabId } = state.desktopByTabId;
    const { [tabId]: _closedSurface, ...surfaceByTabId } = state.surfaceByTabId;

    return withActiveTab(
      {
        ...state,
        suppressedTabIds: state.suppressedTabIds.includes(tabId)
          ? state.suppressedTabIds
          : [...state.suppressedTabIds, tabId],
        desktopByTabId,
        surfaceByTabId,
      },
      sessions,
    );
  });
}

export function setPreviewSurfaceRect(
  ref: ScopedThreadRef,
  tabId: string,
  rect: PreviewSurfaceRect | null,
): void {
  updateThreadState(ref, (state) => {
    const { [tabId]: _previousRect, ...surfaceByTabId } = state.surfaceByTabId;
    return {
      ...state,
      surfaceByTabId: rect
        ? {
            ...surfaceByTabId,
            [tabId]: rect,
          }
        : surfaceByTabId,
    };
  });
}

export function usePreviewSession(
  ref: ScopedThreadRef,
  options: UsePreviewSessionOptions = {},
): void {
  const onError = options.onError;

  useEffect(() => {
    const api = readEnvironmentApi(ref.environmentId);
    if (!api) {
      // A reconnect or environment switch can temporarily leave this ref
      // without an API. The next effect run subscribes when one is available.
      onError?.(new Error("Environment disconnected."));
      return;
    }

    let cancelled = false;
    void api.preview
      .list({ threadId: ref.threadId })
      .then((result) => {
        if (!cancelled) {
          applyPreviewServerSnapshotList(ref, result.sessions);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onError?.(error);
        }
      });

    const unsubscribe = api.preview.onEvent((event) => {
      if (event.threadId !== ref.threadId) {
        return;
      }
      applyPreviewServerEvent(ref, event);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [onError, ref]);
}
