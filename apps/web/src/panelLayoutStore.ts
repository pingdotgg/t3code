/**
 * Per-thread dockable panel layout state.
 *
 * The chat workspace exposes two generic dock slots — `bottom` and `right` —
 * that each host a set of independent tabs. A tab shows one content kind
 * (a terminal session, the diff, ...). This store owns the layout concern:
 * which slots are open, what tabs each slot holds, the active tab, and the
 * react-resizable-panels size. Content specifics (terminal sessions, diff
 * selection) live in their own stores/routes; terminal tabs reference a
 * session by `terminalId` so the terminal store stays canonical for sessions.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

export type PanelSlot = "bottom" | "right";
export type PanelContentKind = "terminal" | "browser" | "diff" | "chat" | "files" | "tasks";

export interface PanelTab {
  id: string;
  kind: PanelContentKind;
  /** Set for terminal tabs; references a session in the terminal store. */
  terminalId?: string;
}

export interface PanelSlotState {
  open: boolean;
  /** Panel size as a react-resizable-panels percentage of the group. */
  size: number;
  tabs: PanelTab[];
  activeTabId: string;
}

export interface ThreadPanelLayoutState {
  bottom: PanelSlotState;
  right: PanelSlotState;
}

const PANEL_LAYOUT_STORAGE_KEY = "t3code:panel-layout:v1";

export const DEFAULT_BOTTOM_PANEL_SIZE = 35;
export const DEFAULT_RIGHT_PANEL_SIZE = 38;

const DEFAULT_BOTTOM_SLOT_STATE: PanelSlotState = Object.freeze({
  open: false,
  size: DEFAULT_BOTTOM_PANEL_SIZE,
  tabs: [],
  activeTabId: "",
});

const DEFAULT_RIGHT_SLOT_STATE: PanelSlotState = Object.freeze({
  open: false,
  size: DEFAULT_RIGHT_PANEL_SIZE,
  tabs: [],
  activeTabId: "",
});

const DEFAULT_THREAD_PANEL_LAYOUT_STATE: ThreadPanelLayoutState = Object.freeze({
  bottom: DEFAULT_BOTTOM_SLOT_STATE,
  right: DEFAULT_RIGHT_SLOT_STATE,
});

function defaultSlotSize(slot: PanelSlot): number {
  return slot === "bottom" ? DEFAULT_BOTTOM_PANEL_SIZE : DEFAULT_RIGHT_PANEL_SIZE;
}

function emptySlotState(slot: PanelSlot): PanelSlotState {
  return { open: false, size: defaultSlotSize(slot), tabs: [], activeTabId: "" };
}

function clampPanelSize(size: number, fallback: number): number {
  if (!Number.isFinite(size)) return fallback;
  return Math.min(90, Math.max(10, size));
}

let tabIdCounter = 0;
function nextTabId(): string {
  tabIdCounter += 1;
  return `tab-${Date.now().toString(36)}-${tabIdCounter}`;
}

function tabsEqual(left: PanelTab[], right: PanelTab[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (a.id !== b.id || a.kind !== b.kind || a.terminalId !== b.terminalId) return false;
  }
  return true;
}

function slotStateEqual(left: PanelSlotState, right: PanelSlotState): boolean {
  return (
    left.open === right.open &&
    left.size === right.size &&
    left.activeTabId === right.activeTabId &&
    tabsEqual(left.tabs, right.tabs)
  );
}

function threadPanelLayoutStateEqual(
  left: ThreadPanelLayoutState,
  right: ThreadPanelLayoutState,
): boolean {
  return slotStateEqual(left.bottom, right.bottom) && slotStateEqual(left.right, right.right);
}

function isEmptySlotState(state: PanelSlotState): boolean {
  return !state.open && state.tabs.length === 0;
}

function isDefaultThreadPanelLayoutState(state: ThreadPanelLayoutState): boolean {
  return isEmptySlotState(state.bottom) && isEmptySlotState(state.right);
}

function createPanelLayoutStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

interface PersistedPanelLayoutStoreState {
  panelLayoutByThreadKey?: Record<string, ThreadPanelLayoutState>;
}

export function migratePersistedPanelLayoutStoreState(
  persistedState: unknown,
  _version: number,
): PersistedPanelLayoutStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return { panelLayoutByThreadKey: {} };
  }
  const candidate = persistedState as PersistedPanelLayoutStoreState;
  const source = candidate.panelLayoutByThreadKey ?? {};
  const panelLayoutByThreadKey = Object.fromEntries(
    Object.entries(source).filter(([threadKey]) => parseScopedThreadKey(threadKey)),
  );
  return { panelLayoutByThreadKey };
}

export function selectThreadPanelLayout(
  panelLayoutByThreadKey: Record<string, ThreadPanelLayoutState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadPanelLayoutState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return DEFAULT_THREAD_PANEL_LAYOUT_STATE;
  }
  return panelLayoutByThreadKey[scopedThreadKey(threadRef)] ?? DEFAULT_THREAD_PANEL_LAYOUT_STATE;
}

function updatePanelLayoutByThreadKey(
  panelLayoutByThreadKey: Record<string, ThreadPanelLayoutState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadPanelLayoutState) => ThreadPanelLayoutState,
): Record<string, ThreadPanelLayoutState> {
  if (threadRef.threadId.length === 0) {
    return panelLayoutByThreadKey;
  }
  const threadKey = scopedThreadKey(threadRef);
  const current = selectThreadPanelLayout(panelLayoutByThreadKey, threadRef);
  const next = updater(current);
  if (threadPanelLayoutStateEqual(next, current)) {
    return panelLayoutByThreadKey;
  }
  if (isDefaultThreadPanelLayoutState(next)) {
    if (panelLayoutByThreadKey[threadKey] === undefined) {
      return panelLayoutByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = panelLayoutByThreadKey;
    return rest;
  }
  return { ...panelLayoutByThreadKey, [threadKey]: next };
}

function updateSlot(
  state: ThreadPanelLayoutState,
  slot: PanelSlot,
  updater: (slotState: PanelSlotState) => PanelSlotState,
): ThreadPanelLayoutState {
  const nextSlot = updater(state[slot]);
  if (slotStateEqual(nextSlot, state[slot])) {
    return state;
  }
  return { ...state, [slot]: nextSlot };
}

/** Close a tab; if the slot empties, close the slot. Returns next slot state. */
function removeTabFromSlot(slotState: PanelSlotState, tabId: string): PanelSlotState {
  const index = slotState.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return slotState;
  const tabs = slotState.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    return { ...slotState, open: false, tabs: [], activeTabId: "" };
  }
  let activeTabId = slotState.activeTabId;
  if (activeTabId === tabId) {
    const fallback = tabs[Math.min(index, tabs.length - 1)] ?? tabs[0];
    activeTabId = fallback?.id ?? "";
  }
  return { ...slotState, tabs, activeTabId };
}

interface PanelLayoutStoreState {
  panelLayoutByThreadKey: Record<string, ThreadPanelLayoutState>;
  /** Add a tab of the given kind to a slot (opening it), returns nothing. */
  addTab: (
    threadRef: ScopedThreadRef,
    slot: PanelSlot,
    tab: { kind: PanelContentKind; terminalId?: string },
  ) => void;
  closeTab: (threadRef: ScopedThreadRef, slot: PanelSlot, tabId: string) => void;
  setActiveTab: (threadRef: ScopedThreadRef, slot: PanelSlot, tabId: string) => void;
  setSlotOpen: (threadRef: ScopedThreadRef, slot: PanelSlot, open: boolean) => void;
  setSlotSize: (threadRef: ScopedThreadRef, slot: PanelSlot, size: number) => void;
  /** Drop any terminal tabs whose session no longer exists. */
  reconcileTerminalTabs: (threadRef: ScopedThreadRef, validTerminalIds: Set<string>) => void;
  removePanelLayout: (threadRef: ScopedThreadRef) => void;
  removeOrphanedPanelLayouts: (activeThreadKeys: Set<string>) => void;
}

export const usePanelLayoutStore = create<PanelLayoutStoreState>()(
  persist(
    (set) => {
      const update = (
        threadRef: ScopedThreadRef,
        updater: (state: ThreadPanelLayoutState) => ThreadPanelLayoutState,
      ) => {
        set((state) => {
          const next = updatePanelLayoutByThreadKey(
            state.panelLayoutByThreadKey,
            threadRef,
            updater,
          );
          if (next === state.panelLayoutByThreadKey) {
            return state;
          }
          return { panelLayoutByThreadKey: next };
        });
      };

      return {
        panelLayoutByThreadKey: {},
        addTab: (threadRef, slot, tab) =>
          update(threadRef, (state) =>
            updateSlot(state, slot, (slotState) => {
              // Browser, diff, and tasks are singletons per slot; focus the
              // existing one instead of adding a duplicate.
              if (tab.kind === "browser" || tab.kind === "diff" || tab.kind === "tasks") {
                const existing = slotState.tabs.find(
                  (existingTab) => existingTab.kind === tab.kind,
                );
                if (existing) {
                  return { ...slotState, open: true, activeTabId: existing.id };
                }
              }
              const newTab: PanelTab = {
                id: nextTabId(),
                kind: tab.kind,
                ...(tab.terminalId !== undefined ? { terminalId: tab.terminalId } : {}),
              };
              return {
                ...slotState,
                open: true,
                tabs: [...slotState.tabs, newTab],
                activeTabId: newTab.id,
              };
            }),
          ),
        closeTab: (threadRef, slot, tabId) =>
          update(threadRef, (state) =>
            updateSlot(state, slot, (slotState) => removeTabFromSlot(slotState, tabId)),
          ),
        setActiveTab: (threadRef, slot, tabId) =>
          update(threadRef, (state) =>
            updateSlot(state, slot, (slotState) =>
              slotState.tabs.some((tab) => tab.id === tabId) && slotState.activeTabId !== tabId
                ? { ...slotState, activeTabId: tabId }
                : slotState,
            ),
          ),
        setSlotOpen: (threadRef, slot, open) =>
          update(threadRef, (state) =>
            updateSlot(state, slot, (slotState) =>
              slotState.open === open ? slotState : { ...slotState, open },
            ),
          ),
        setSlotSize: (threadRef, slot, size) =>
          update(threadRef, (state) =>
            updateSlot(state, slot, (slotState) => {
              const nextSize = clampPanelSize(size, defaultSlotSize(slot));
              return slotState.size === nextSize ? slotState : { ...slotState, size: nextSize };
            }),
          ),
        reconcileTerminalTabs: (threadRef, validTerminalIds) =>
          update(threadRef, (state) => {
            const reconcileSlot = (slotState: PanelSlotState): PanelSlotState => {
              const tabs = slotState.tabs.filter(
                (tab) => tab.kind !== "terminal" || validTerminalIds.has(tab.terminalId ?? ""),
              );
              if (tabs.length === slotState.tabs.length) {
                return slotState;
              }
              if (tabs.length === 0) {
                return { ...slotState, open: false, tabs: [], activeTabId: "" };
              }
              const activeTabId = tabs.some((tab) => tab.id === slotState.activeTabId)
                ? slotState.activeTabId
                : (tabs[tabs.length - 1]?.id ?? "");
              return { ...slotState, tabs, activeTabId };
            };
            return {
              bottom: reconcileSlot(state.bottom),
              right: reconcileSlot(state.right),
            };
          }),
        removePanelLayout: (threadRef) =>
          set((state) => {
            const threadKey = scopedThreadKey(threadRef);
            if (state.panelLayoutByThreadKey[threadKey] === undefined) {
              return state;
            }
            const next = { ...state.panelLayoutByThreadKey };
            delete next[threadKey];
            return { panelLayoutByThreadKey: next };
          }),
        removeOrphanedPanelLayouts: (activeThreadKeys) =>
          set((state) => {
            const orphaned = Object.keys(state.panelLayoutByThreadKey).filter(
              (key) => !activeThreadKeys.has(key),
            );
            if (orphaned.length === 0) {
              return state;
            }
            const next = { ...state.panelLayoutByThreadKey };
            for (const key of orphaned) {
              delete next[key];
            }
            return { panelLayoutByThreadKey: next };
          }),
      };
    },
    {
      name: PANEL_LAYOUT_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createPanelLayoutStorage),
      migrate: migratePersistedPanelLayoutStoreState,
      partialize: (state) => ({
        panelLayoutByThreadKey: state.panelLayoutByThreadKey,
      }),
    },
  ),
);

export { DEFAULT_THREAD_PANEL_LAYOUT_STATE, emptySlotState };
