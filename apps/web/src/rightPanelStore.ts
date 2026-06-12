/**
 * Thread-scoped right-panel surface state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids;
 * singleton surfaces bridge the existing terminal, diff, and plan features.
 */
import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const RIGHT_PANEL_KINDS = ["plan", "diff", "preview", "terminal"] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "terminal"; kind: "terminal" }
  | { id: "diff"; kind: "diff" }
  | { id: "plan"; kind: "plan" };

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";

export interface ThreadRightPanelState {
  activeSurfaceId: string | null;
  surfaces: RightPanelSurface[];
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  open: (ref: ScopedThreadRef, kind: RightPanelKind) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  close: (ref: ScopedThreadRef) => void;
  toggle: (ref: ScopedThreadRef, kind: RightPanelKind) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadRightPanelState = { activeSurfaceId: null, surfaces: [] };

const singletonSurface = (kind: Exclude<RightPanelKind, "preview">): RightPanelSurface => {
  switch (kind) {
    case "terminal":
      return { id: "terminal", kind };
    case "diff":
      return { id: "diff", kind };
    case "plan":
      return { id: "plan", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const upsertSurface = (
  current: ThreadRightPanelState,
  surface: RightPanelSurface,
  activate = true,
): ThreadRightPanelState => ({
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThread = (
  byThreadKey: Record<string, ThreadRightPanelState>,
  threadKey: string,
  updater: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Record<string, ThreadRightPanelState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      open: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      openBrowser: (ref, tabId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = browserSurface(tabId);
            const withoutPlaceholder = tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces;
            return upsertSurface({ ...current, surfaces: withoutPlaceholder }, surface);
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (current.activeSurfaceId !== surfaceId) return { ...current, surfaces };
            const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
            return { surfaces, activeSurfaceId: fallback?.id ?? null };
          }),
        })),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const validIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
            const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
            const existingBrowser = current.surfaces.filter(
              (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                surface.kind === "preview" &&
                surface.id !== "browser:new" &&
                validIds.has(surface.id),
            );
            const knownIds = new Set(existingBrowser.map((surface) => surface.id));
            const added = tabIds
              .filter((tabId) => !knownIds.has(`browser:${tabId}`))
              .map((tabId) => browserSurface(tabId));
            const surfaces = [...nonBrowser, ...existingBrowser, ...added];
            const activeStillExists = surfaces.some(
              (surface) => surface.id === current.activeSurfaceId,
            );
            const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
            return {
              surfaces,
              activeSurfaceId: activeStillExists
                ? current.activeSurfaceId
                : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
            };
          }),
        })),
      close: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: null,
          })),
        })),
      toggle: (ref, kind) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const active = current.surfaces.find(
              (surface) => surface.id === current.activeSurfaceId,
            );
            if (active?.kind === kind) return { ...current, activeSurfaceId: null };
            if (kind === "preview") {
              const existing = current.surfaces.find((surface) => surface.kind === "preview");
              return upsertSurface(current, existing ?? browserSurface(null));
            }
            return upsertSurface(current, singletonSurface(kind));
          }),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectActiveRightPanelKindWithUrl(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
  diffSearchActive: boolean,
): RightPanelKind | null {
  if (diffSearchActive) return "diff";
  return selectActiveRightPanel(byThreadKey, ref);
}
