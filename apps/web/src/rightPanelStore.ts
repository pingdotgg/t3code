import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export type RightPanelKind = "plan" | "diff" | "files" | "file" | "preview" | "terminal";

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | { id: "plan"; kind: "plan" }
  | { id: `file:${string}`; kind: "file"; relativePath: string; revealLine: number | null }
  | { id: `terminal:${string}`; kind: "terminal"; resourceId: string };

export interface ThreadRightPanelState {
  readonly isOpen: boolean;
  readonly activeSurfaceId: string | null;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
}

interface RightPanelStoreState {
  readonly byThreadKey: Readonly<Record<string, ThreadRightPanelState>>;
  readonly open: (ref: ScopedThreadRef, kind: Exclude<RightPanelKind, "file" | "terminal">) => void;
  readonly openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  readonly openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  readonly openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  readonly activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  readonly closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  readonly closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  readonly closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  readonly closeAllSurfaces: (ref: ScopedThreadRef) => void;
  readonly reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  readonly show: (ref: ScopedThreadRef) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly closeBrowser: (ref: ScopedThreadRef) => void;
  readonly toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal">,
  ) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_STATE: ThreadRightPanelState = Object.freeze({
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
});

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal">,
): RightPanelSurface => ({ id: kind, kind }) as RightPanelSurface;

function updateState(
  byThreadKey: Readonly<Record<string, ThreadRightPanelState>>,
  ref: ScopedThreadRef,
  update: (current: ThreadRightPanelState) => ThreadRightPanelState,
): Readonly<Record<string, ThreadRightPanelState>> {
  const key = scopedThreadKey(ref);
  const current = byThreadKey[key] ?? EMPTY_STATE;
  const next = update(current);
  if (next === current) return byThreadKey;
  if (!next.isOpen && next.surfaces.length === 0) {
    const { [key]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return { ...byThreadKey, [key]: next };
}

function upsert(current: ThreadRightPanelState, surface: RightPanelSurface): ThreadRightPanelState {
  const existing = current.surfaces.find((entry) => entry.id === surface.id);
  if (current.isOpen && current.activeSurfaceId === surface.id && existing === surface) {
    return current;
  }
  return {
    isOpen: true,
    activeSurfaceId: surface.id,
    surfaces: current.surfaces.some((entry) => entry.id === surface.id)
      ? current.surfaces
      : [...current.surfaces, surface],
  };
}

export const useRightPanelStore = create<RightPanelStoreState>()((set) => ({
  byThreadKey: {},
  open: (ref, kind) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        if (kind === "preview") {
          return upsert(
            current,
            current.surfaces.find((surface) => surface.kind === "preview") ?? browserSurface(null),
          );
        }
        return upsert(current, singletonSurface(kind));
      }),
    })),
  openBrowser: (ref, tabId) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        const surface = browserSurface(tabId);
        const surfaces = tabId
          ? current.surfaces.filter((entry) => entry.id !== "browser:new")
          : current.surfaces;
        return upsert({ ...current, surfaces }, surface);
      }),
    })),
  openFile: (ref, relativePath, line) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) =>
        upsert(current, {
          id: `file:${relativePath}`,
          kind: "file",
          relativePath,
          revealLine: line === undefined ? null : Math.max(1, Math.trunc(line)),
        }),
      ),
    })),
  openTerminal: (ref, terminalId) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) =>
        upsert(current, { id: `terminal:${terminalId}`, kind: "terminal", resourceId: terminalId }),
      ),
    })),
  activateSurface: (ref, surfaceId) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) =>
        current.surfaces.some((surface) => surface.id === surfaceId)
          ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
          : current,
      ),
    })),
  closeSurface: (ref, surfaceId) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
        if (index < 0) return current;
        const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
        const activeSurfaceId =
          current.activeSurfaceId === surfaceId
            ? (surfaces[Math.min(index, surfaces.length - 1)]?.id ?? null)
            : current.activeSurfaceId;
        return { isOpen: current.isOpen && surfaces.length > 0, surfaces, activeSurfaceId };
      }),
    })),
  closeOtherSurfaces: (ref, surfaceId) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        const surface = current.surfaces.find((entry) => entry.id === surfaceId);
        return surface
          ? { isOpen: true, surfaces: [surface], activeSurfaceId: surface.id }
          : current;
      }),
    })),
  closeSurfacesToRight: (ref, surfaceId) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
        if (index < 0 || index === current.surfaces.length - 1) return current;
        const surfaces = current.surfaces.slice(0, index + 1);
        return {
          ...current,
          surfaces,
          activeSurfaceId: surfaces.some((surface) => surface.id === current.activeSurfaceId)
            ? current.activeSurfaceId
            : surfaceId,
        };
      }),
    })),
  closeAllSurfaces: (ref) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, () => EMPTY_STATE),
    })),
  reconcileBrowserSurfaces: (ref, tabIds) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        const browserIds = new Set(tabIds.map((tabId) => `browser:${tabId}`));
        const retained = current.surfaces.filter((surface) => {
          if (surface.kind !== "preview") return true;
          if (surface.id === "browser:new") return tabIds.length === 0;
          return browserIds.has(surface.id);
        });
        const known = new Set(retained.map((surface) => surface.id));
        const surfaces = [
          ...retained,
          ...tabIds.filter((id) => !known.has(`browser:${id}`)).map(browserSurface),
        ];
        const activeSurfaceId = surfaces.some((surface) => surface.id === current.activeSurfaceId)
          ? current.activeSurfaceId
          : (surfaces.find((surface) => surface.kind === "preview")?.id ?? surfaces[0]?.id ?? null);
        if (
          surfaces.length === current.surfaces.length &&
          surfaces.every((surface, index) => surface === current.surfaces[index]) &&
          activeSurfaceId === current.activeSurfaceId
        ) {
          return current;
        }
        return { ...current, surfaces, activeSurfaceId };
      }),
    })),
  show: (ref) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => ({ ...current, isOpen: true })),
    })),
  close: (ref) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => ({
        ...current,
        isOpen: false,
      })),
    })),
  closeBrowser: (ref) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => ({
        ...current,
        isOpen: false,
      })),
    })),
  toggle: (ref, kind) =>
    set((state) => ({
      byThreadKey: updateState(state.byThreadKey, ref, (current) => {
        const active = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
        if (current.isOpen && active?.kind === kind) return { ...current, isOpen: false };
        if (kind === "preview") {
          return upsert(
            current,
            current.surfaces.find((surface) => surface.kind === "preview") ?? browserSurface(null),
          );
        }
        return upsert(current, singletonSurface(kind));
      }),
    })),
  removeThread: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!(key in state.byThreadKey)) return state;
      const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectThreadRightPanelState(
  byThreadKey: Readonly<Record<string, ThreadRightPanelState>>,
  ref: ScopedThreadRef | null,
): ThreadRightPanelState {
  return ref ? (byThreadKey[scopedThreadKey(ref)] ?? EMPTY_STATE) : EMPTY_STATE;
}

const selectRightPanelStates = (state: RightPanelStoreState) => state.byThreadKey;

export function useBrowserPanelState(ref: ScopedThreadRef | null): ThreadRightPanelState {
  const byThreadKey = useRightPanelStore(selectRightPanelStates);
  return selectThreadRightPanelState(byThreadKey, ref);
}
