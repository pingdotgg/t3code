import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type { DesktopPreviewFavicon, ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { normalizeHostname } from "~/browser/browserTargetResolver";
import { readThreadShell, useQuietThreadShell } from "~/state/entities";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";

import {
  BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY,
  type BrowserFaviconEntry,
  canCanonicalizeFaviconWithoutEnvironment,
  evictExcessFavicons,
  faviconKey,
  faviconStorageLocation,
  isStorableFaviconDataUrl,
  isValidFaviconCapturedAt,
  migratePersistedBrowserFaviconState,
} from "./browserFaviconLogic";
import { useComposerDraftStore } from "./composerDraftStore";
import { createMemoryStorage, type StateStorage } from "./lib/storage";

const BROWSER_FAVICON_STORAGE_KEY = "t3code:browser-favicons:v1";
const MAX_PENDING_ORIGINS_PER_THREAD = 10;
const MAX_PENDING_THREADS = 20;

type PendingFavicon = DesktopPreviewFavicon;
type PendingFaviconsByOrigin = Record<string, PendingFavicon>;

export interface BrowserFaviconStoreState {
  byKey: Record<string, BrowserFaviconEntry>;
  pendingByThreadKey: Record<string, PendingFaviconsByOrigin>;
  recordFavicon: (
    key: string,
    dataUrl: string,
    capturedAt: number,
    aliases?: ReadonlyArray<string>,
  ) => void;
}

function pendingOriginKey(pageUrl: string): string | null {
  return faviconKey("pending", pageUrl, null)?.slice("pending ".length) ?? null;
}

function addPendingFavicon(
  pendingByThreadKey: Record<string, PendingFaviconsByOrigin>,
  threadKey: string,
  favicon: PendingFavicon,
): Record<string, PendingFaviconsByOrigin> {
  const originKey = pendingOriginKey(favicon.pageUrl);
  if (!originKey) return pendingByThreadKey;
  const current = pendingByThreadKey[threadKey] ?? {};
  const existing = current[originKey];
  if (existing && existing.capturedAt >= favicon.capturedAt) return pendingByThreadKey;
  const nextForThread = {
    ...current,
    [originKey]: favicon,
  };
  const boundedForThread = Object.fromEntries(
    Object.entries(nextForThread)
      .toSorted(([, left], [, right]) => right.capturedAt - left.capturedAt)
      .slice(0, MAX_PENDING_ORIGINS_PER_THREAD),
  );

  const withoutThread = { ...pendingByThreadKey };
  delete withoutThread[threadKey];
  return Object.fromEntries(
    [...Object.entries(withoutThread), [threadKey, boundedForThread]].slice(-MAX_PENDING_THREADS),
  );
}

export function resolveBrowserFaviconStorage(): StateStorage {
  const fallback = createMemoryStorage();
  const shadowedNames = new Set<string>();
  let primary: Storage;
  try {
    if (typeof window === "undefined") return fallback;
    primary = window.localStorage;
  } catch {
    return fallback;
  }
  return {
    getItem: (name) => {
      if (shadowedNames.has(name)) return fallback.getItem(name);
      try {
        return primary.getItem(name);
      } catch {
        return fallback.getItem(name);
      }
    },
    setItem: (name, value) => {
      fallback.setItem(name, value);
      try {
        primary.setItem(name, value);
        shadowedNames.delete(name);
      } catch {
        shadowedNames.add(name);
      }
    },
    removeItem: (name) => {
      fallback.removeItem(name);
      try {
        primary.removeItem(name);
        shadowedNames.delete(name);
      } catch {
        shadowedNames.add(name);
      }
    },
  };
}

export const useBrowserFaviconStore = create<BrowserFaviconStoreState>()(
  persist(
    (set) => ({
      byKey: {},
      pendingByThreadKey: {},
      recordFavicon: (key, dataUrl, capturedAt, aliases = []) =>
        set((state) => {
          if (!isStorableFaviconDataUrl(dataUrl)) return state;
          if (!isValidFaviconCapturedAt(capturedAt)) return state;
          const existing = state.byKey[key];
          const aliasCandidates =
            capturedAt > (existing?.capturedAt ?? -1)
              ? [...aliases, ...(existing?.aliases ?? [])]
              : [...(existing?.aliases ?? []), ...aliases];
          const nextAliases = [...new Set(aliasCandidates)].slice(
            0,
            BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY,
          );
          const aliasesUnchanged =
            nextAliases.length === (existing?.aliases?.length ?? 0) &&
            nextAliases.every((alias, index) => alias === existing?.aliases?.[index]);
          if (existing && capturedAt <= existing.capturedAt && aliasesUnchanged) return state;
          return {
            byKey: evictExcessFavicons({
              ...state.byKey,
              [key]: {
                dataUrl: capturedAt > (existing?.capturedAt ?? -1) ? dataUrl : existing!.dataUrl,
                capturedAt: Math.max(capturedAt, existing?.capturedAt ?? -1),
                ...(nextAliases.length > 0 ? { aliases: nextAliases } : {}),
              },
            }),
          };
        }),
    }),
    {
      name: BROWSER_FAVICON_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(resolveBrowserFaviconStorage),
      partialize: (state) => ({ byKey: state.byKey }),
      migrate: migratePersistedBrowserFaviconState,
      merge: mergeBrowserFaviconState,
    },
  ),
);

function mergeBrowserFaviconState(
  persistedState: unknown,
  currentState: BrowserFaviconStoreState,
): BrowserFaviconStoreState {
  return {
    ...currentState,
    ...migratePersistedBrowserFaviconState(persistedState),
  };
}

/** Server threads name their project in the shell; drafts in the composer draft store. */
function useFaviconProjectRefForThread(threadRef: ScopedThreadRef): ScopedProjectRef | null {
  const shell = useQuietThreadShell(threadRef);
  const draftProjectRef = useComposerDraftStore((state) => {
    const draft = state.draftThreadsByThreadKey[scopedThreadKey(threadRef)];
    return draft ? scopedProjectKey(scopeProjectRef(draft.environmentId, draft.projectId)) : null;
  });
  if (shell?.projectId) return scopeProjectRef(threadRef.environmentId, shell.projectId);
  return draftProjectRef === null ? null : parseScopedProjectKey(draftProjectRef);
}

function readThreadProjectRef(threadRef: ScopedThreadRef): ScopedProjectRef | null {
  const projectId = readThreadShell(threadRef)?.projectId;
  if (projectId) return scopeProjectRef(threadRef.environmentId, projectId);
  const draft =
    useComposerDraftStore.getState().draftThreadsByThreadKey[scopedThreadKey(threadRef)];
  return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
}

export function recordFaviconForProject(
  projectRef: ScopedProjectRef,
  favicon: DesktopPreviewFavicon,
  environmentHostname: string | null,
): boolean {
  if (!isStorableFaviconDataUrl(favicon.dataUrl) || !isValidFaviconCapturedAt(favicon.capturedAt)) {
    return false;
  }
  const location = faviconStorageLocation(
    scopedProjectKey(projectRef),
    favicon.pageUrl,
    environmentHostname,
  );
  if (!location) return false;
  const state = useBrowserFaviconStore.getState();
  const existing = state.byKey[location.key];
  if (
    existing &&
    existing.capturedAt >= favicon.capturedAt &&
    location.aliases.every((alias) => existing.aliases?.includes(alias))
  )
    return true;
  state.recordFavicon(location.key, favicon.dataUrl, favicon.capturedAt, location.aliases);
  return true;
}

/**
 * The thread's project and environment host may not be known yet when a capture
 * arrives; such captures wait per thread and land with the next capture that can
 * resolve them.
 */
export function recordFaviconForThread(
  threadRef: ScopedThreadRef,
  favicon: DesktopPreviewFavicon,
): boolean {
  if (
    !isStorableFaviconDataUrl(favicon.dataUrl) ||
    !isValidFaviconCapturedAt(favicon.capturedAt) ||
    !pendingOriginKey(favicon.pageUrl)
  )
    return false;
  const projectRef = readThreadProjectRef(threadRef);
  const connection = readPreparedConnection(threadRef.environmentId);
  const environmentHostname = connection ? new URL(connection.httpBaseUrl).hostname : undefined;
  if (projectRef) flushPendingFaviconsForThread(threadRef, projectRef, environmentHostname);
  const hostname =
    environmentHostname !== undefined
      ? environmentHostname
      : canCanonicalizeFaviconWithoutEnvironment(favicon.pageUrl)
        ? null
        : undefined;
  if (
    projectRef &&
    hostname !== undefined &&
    recordFaviconForProject(projectRef, favicon, hostname)
  ) {
    return true;
  }
  const threadKey = scopedThreadKey(threadRef);
  const state = useBrowserFaviconStore.getState();
  const pendingByThreadKey = addPendingFavicon(state.pendingByThreadKey, threadKey, favicon);
  if (pendingByThreadKey !== state.pendingByThreadKey) {
    useBrowserFaviconStore.setState({ pendingByThreadKey });
  }
  return false;
}

function flushPendingFaviconsForThread(
  threadRef: ScopedThreadRef,
  projectRef: ScopedProjectRef,
  environmentHostname: string | undefined,
): boolean {
  const threadKey = scopedThreadKey(threadRef);
  const pending = useBrowserFaviconStore.getState().pendingByThreadKey[threadKey];
  if (!pending) return true;
  const remaining = Object.fromEntries(
    Object.entries(pending).filter(([, favicon]) => {
      const hostname =
        environmentHostname !== undefined
          ? environmentHostname
          : canCanonicalizeFaviconWithoutEnvironment(favicon.pageUrl)
            ? null
            : undefined;
      return hostname === undefined || !recordFaviconForProject(projectRef, favicon, hostname);
    }),
  );
  useBrowserFaviconStore.setState((state) => {
    const pendingByThreadKey = { ...state.pendingByThreadKey };
    if (Object.keys(remaining).length === 0) delete pendingByThreadKey[threadKey];
    else pendingByThreadKey[threadKey] = remaining;
    return { pendingByThreadKey };
  });
  return Object.keys(remaining).length === 0;
}

export function useFaviconForThreadUrl(threadRef: ScopedThreadRef, url: string): string | null {
  const projectRef = useFaviconProjectRefForThread(threadRef);
  const preparedConnection = usePreparedConnection(threadRef.environmentId);
  const environmentHostname = Option.isSome(preparedConnection)
    ? new URL(preparedConnection.value.httpBaseUrl).hostname
    : null;
  const threadKey = scopedThreadKey(threadRef);
  return useBrowserFaviconStore((state) =>
    lookupFaviconForThread(state, threadKey, projectRef, url, environmentHostname),
  );
}

/**
 * A capture waiting for its thread's project still shows on that thread, and wins
 * over an older stored capture for the same origin.
 */
export function lookupFaviconForThread(
  state: Pick<BrowserFaviconStoreState, "byKey" | "pendingByThreadKey">,
  threadKey: string,
  projectRef: ScopedProjectRef | null,
  url: string,
  environmentHostname: string | null,
): string | null {
  const stored = lookupFaviconEntry(state.byKey, projectRef, url, environmentHostname);
  const originKey = pendingOriginKey(url);
  const pending = originKey ? state.pendingByThreadKey[threadKey]?.[originKey] : undefined;
  if (pending && (!stored || pending.capturedAt > stored.capturedAt)) return pending.dataUrl;
  return stored?.dataUrl ?? null;
}

export function lookupFavicon(
  byKey: Record<string, BrowserFaviconEntry>,
  projectRef: ScopedProjectRef | null,
  url: string,
  environmentHostname: string | null,
): string | null {
  return lookupFaviconEntry(byKey, projectRef, url, environmentHostname)?.dataUrl ?? null;
}

function lookupFaviconEntry(
  byKey: Record<string, BrowserFaviconEntry>,
  projectRef: ScopedProjectRef | null,
  url: string,
  environmentHostname: string | null,
): BrowserFaviconEntry | null {
  const key = projectRef
    ? faviconKey(scopedProjectKey(projectRef), url, environmentHostname)
    : null;
  if (!key) return null;
  const direct = byKey[key];
  if (direct) return direct;
  try {
    const requestedHost = normalizeHostname(new URL(url).hostname);
    const localKey = faviconKey(scopedProjectKey(projectRef!), url, requestedHost);
    const localEntry = localKey ? byKey[localKey] : null;
    return localEntry?.aliases?.includes(requestedHost) ? localEntry : null;
  } catch {
    return null;
  }
}

export function resetBrowserFaviconsForTests(): void {
  useBrowserFaviconStore.setState({
    byKey: {},
    pendingByThreadKey: {},
  });
  useBrowserFaviconStore.persist.clearStorage();
}
