import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import * as Option from "effect/Option";

import { readPreparedConnection, usePreparedConnection } from "~/state/session";

import {
  type BrowserFaviconEntry,
  evictExcessFavicons,
  faviconKey,
  isStorableFaviconDataUrl,
  migratePersistedBrowserFaviconState,
} from "./browserFaviconLogic";
import { resolveStorage } from "./lib/storage";

const BROWSER_FAVICON_STORAGE_KEY = "t3code:browser-favicons:v1";

export interface BrowserFaviconStoreState {
  byKey: Record<string, BrowserFaviconEntry>;
  projectKeyByThreadKey: Record<string, string>;
  pendingByThreadKey: Record<string, PendingFavicon[]>;
  recordFavicon: (key: string, dataUrl: string, at: number) => void;
  registerThreadProject: (ref: ScopedThreadRef, projectKey: string) => void;
}

type PendingFavicon = { url: string; dataUrl: string; at: number };
const MAX_PENDING_FAVICONS_PER_THREAD = 10;

function addPendingFavicon(
  pendingByThreadKey: Record<string, PendingFavicon[]>,
  threadKey: string,
  favicon: PendingFavicon,
): Record<string, PendingFavicon[]> {
  const current = pendingByThreadKey[threadKey] ?? [];
  const duplicate = current.find(
    (candidate) => candidate.url === favicon.url && candidate.dataUrl === favicon.dataUrl,
  );
  const pending = current.filter(
    (candidate) => candidate.url !== favicon.url || candidate.dataUrl !== favicon.dataUrl,
  );
  const newest = duplicate && duplicate.at >= favicon.at ? duplicate : favicon;
  return {
    ...pendingByThreadKey,
    [threadKey]: [...pending, newest]
      .sort((left, right) => left.at - right.at)
      .slice(-MAX_PENDING_FAVICONS_PER_THREAD),
  };
}

export function resolveBrowserFaviconStorage() {
  try {
    return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
  } catch {
    return resolveStorage(undefined);
  }
}

export const useBrowserFaviconStore = create<BrowserFaviconStoreState>()(
  persist(
    (set, get) => ({
      byKey: {},
      projectKeyByThreadKey: {},
      pendingByThreadKey: {},
      recordFavicon: (key, dataUrl, at) =>
        set((state) => {
          if (!isStorableFaviconDataUrl(dataUrl)) return state;
          const existing = state.byKey[key];
          if (existing && at <= existing.updatedAt) return state;
          if (existing?.dataUrl === dataUrl) {
            return { byKey: { ...state.byKey, [key]: { ...existing, updatedAt: at } } };
          }
          return {
            byKey: evictExcessFavicons({ ...state.byKey, [key]: { dataUrl, updatedAt: at } }),
          };
        }),
      registerThreadProject: (ref, projectKey) => {
        const threadKey = scopedThreadKey(ref);
        const state = get();
        if (state.projectKeyByThreadKey[threadKey] !== projectKey) {
          set({
            projectKeyByThreadKey: { ...state.projectKeyByThreadKey, [threadKey]: projectKey },
          });
        }
        flushPendingFaviconsForThread(ref);
      },
    }),
    {
      name: BROWSER_FAVICON_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(resolveBrowserFaviconStorage),
      partialize: (state) => ({
        byKey: state.byKey,
        projectKeyByThreadKey: state.projectKeyByThreadKey,
      }),
      migrate: migratePersistedBrowserFaviconState,
      merge: mergeBrowserFaviconState,
    },
  ),
);

export function mergeBrowserFaviconState(
  persistedState: unknown,
  currentState: BrowserFaviconStoreState,
): BrowserFaviconStoreState {
  const projectKeyByThreadKey =
    persistedState &&
    typeof persistedState === "object" &&
    "projectKeyByThreadKey" in persistedState &&
    persistedState.projectKeyByThreadKey &&
    typeof persistedState.projectKeyByThreadKey === "object" &&
    !Array.isArray(persistedState.projectKeyByThreadKey)
      ? Object.fromEntries(
          Object.entries(persistedState.projectKeyByThreadKey)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .slice(-100),
        )
      : {};
  return {
    ...currentState,
    ...migratePersistedBrowserFaviconState(persistedState),
    projectKeyByThreadKey: { ...projectKeyByThreadKey, ...currentState.projectKeyByThreadKey },
  };
}

function resolveFaviconKey(
  projectKey: string,
  environmentId: ScopedProjectRef["environmentId"],
  url: string,
): string | null {
  const connection = readPreparedConnection(environmentId);
  if (!connection) return null;
  return faviconKey(projectKey, url, new URL(connection.httpBaseUrl).hostname);
}

function recordFaviconForProjectKey(
  projectKey: string,
  environmentId: ScopedProjectRef["environmentId"],
  url: string,
  dataUrl: string,
  at: number,
): boolean {
  if (!isStorableFaviconDataUrl(dataUrl)) return false;
  const key = resolveFaviconKey(projectKey, environmentId, url);
  if (!key) return false;
  useBrowserFaviconStore.getState().recordFavicon(key, dataUrl, at);
  return true;
}

export function recordFaviconForProject(
  ref: ScopedProjectRef,
  url: string,
  dataUrl: string,
  at?: number,
): boolean {
  return recordFaviconForProjectKey(
    scopedProjectKey(ref),
    ref.environmentId,
    url,
    dataUrl,
    at ?? Date.now(),
  );
}

export function recordFaviconForThread(
  ref: ScopedThreadRef,
  url: string,
  dataUrl: string,
  at = Date.now(),
): boolean {
  if (!isStorableFaviconDataUrl(dataUrl)) return false;
  const threadKey = scopedThreadKey(ref);
  const state = useBrowserFaviconStore.getState();
  const projectKey = state.projectKeyByThreadKey[threadKey];
  if (projectKey && recordFaviconForProjectKey(projectKey, ref.environmentId, url, dataUrl, at))
    return true;
  if (!faviconKey("pending", url, null)) return false;
  useBrowserFaviconStore.setState({
    pendingByThreadKey: addPendingFavicon(state.pendingByThreadKey, threadKey, {
      url,
      dataUrl,
      at,
    }),
  });
  return false;
}

export function flushPendingFaviconsForThread(ref: ScopedThreadRef): boolean {
  const threadKey = scopedThreadKey(ref);
  const state = useBrowserFaviconStore.getState();
  const projectKey = state.projectKeyByThreadKey[threadKey];
  const pending = state.pendingByThreadKey[threadKey];
  if (!projectKey || !pending || !readPreparedConnection(ref.environmentId)) return false;
  const remaining = pending.filter(
    (favicon) =>
      !recordFaviconForProjectKey(
        projectKey,
        ref.environmentId,
        favicon.url,
        favicon.dataUrl,
        favicon.at,
      ),
  );
  const pendingByThreadKey = { ...useBrowserFaviconStore.getState().pendingByThreadKey };
  if (remaining.length === 0) delete pendingByThreadKey[threadKey];
  else pendingByThreadKey[threadKey] = remaining;
  useBrowserFaviconStore.setState({ pendingByThreadKey });
  return remaining.length === 0;
}

export function useFaviconForThreadUrl(ref: ScopedThreadRef, url: string): string | null {
  const preparedConnection = usePreparedConnection(ref.environmentId);
  const environmentHostname = Option.isSome(preparedConnection)
    ? new URL(preparedConnection.value.httpBaseUrl).hostname
    : null;
  return useBrowserFaviconStore((state) => {
    const projectKey = state.projectKeyByThreadKey[scopedThreadKey(ref)];
    const key = projectKey ? faviconKey(projectKey, url, environmentHostname) : null;
    return key ? (state.byKey[key]?.dataUrl ?? null) : null;
  });
}

export function resetBrowserFaviconsForTests(): void {
  useBrowserFaviconStore.setState({
    byKey: {},
    projectKeyByThreadKey: {},
    pendingByThreadKey: {},
  });
  useBrowserFaviconStore.persist.clearStorage();
}
