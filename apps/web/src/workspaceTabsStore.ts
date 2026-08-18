import { create } from "zustand";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export interface WorkspaceTab {
  readonly key: string;
  readonly kind: "server";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectId?: ProjectId | null | undefined;
  readonly projectCwd?: string | null | undefined;
  readonly projectName?: string | null | undefined;
  readonly faviconPath?: string | null | undefined;
  readonly pinned?: boolean | undefined;
}

export function serverTabKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `server:${environmentId}:${threadId}`;
}

export interface WorkspaceTabsState {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeTabKey: string | null;
  readonly openTab: (tab: WorkspaceTab) => void;
  readonly closeTab: (tabKey: string) => WorkspaceTab | null;
  readonly closeOtherTabs: (keepTabKey: string) => void;
  readonly closeTabsToRight: (fromTabKey: string) => void;
  readonly closeAllTabs: () => void;
  readonly reorderTabs: (sourceKey: string, targetKey: string) => void;
  readonly togglePinTab: (tabKey: string) => void;
}

export const WORKSPACE_TABS_STORAGE_KEY = "t3code:workspace-tabs:v1";

interface PersistedTabsPayload {
  tabs: WorkspaceTab[];
  activeTabKey: string | null;
}

function loadPersistedTabs(): { tabs: WorkspaceTab[]; activeTabKey: string | null } {
  if (typeof window === "undefined" || !window.localStorage) {
    return { tabs: [], activeTabKey: null };
  }
  try {
    const raw = window.localStorage.getItem(WORKSPACE_TABS_STORAGE_KEY);
    if (!raw) return { tabs: [], activeTabKey: null };
    const parsed = JSON.parse(raw) as PersistedTabsPayload;
    if (!parsed || !Array.isArray(parsed.tabs)) {
      return { tabs: [], activeTabKey: null };
    }
    const seen = new Set<string>();
    const sanitizedTabs: WorkspaceTab[] = [];
    for (const tab of parsed.tabs) {
      if (
        tab &&
        tab.kind === "server" &&
        typeof tab.environmentId === "string" &&
        typeof tab.threadId === "string"
      ) {
        const key = serverTabKey(tab.environmentId as EnvironmentId, tab.threadId as ThreadId);
        if (!seen.has(key)) {
          seen.add(key);
          sanitizedTabs.push({
            ...tab,
            key,
            kind: "server",
            environmentId: tab.environmentId as EnvironmentId,
            threadId: tab.threadId as ThreadId,
          });
        }
      }
    }
    const activeTabKey =
      typeof parsed.activeTabKey === "string" &&
      sanitizedTabs.some((tab) => tab.key === parsed.activeTabKey)
        ? parsed.activeTabKey
        : (sanitizedTabs[0]?.key ?? null);
    return { tabs: sanitizedTabs, activeTabKey };
  } catch {
    return { tabs: [], activeTabKey: null };
  }
}

function savePersistedTabs(tabs: readonly WorkspaceTab[], activeTabKey: string | null): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const payload: PersistedTabsPayload = {
      tabs: [...tabs],
      activeTabKey,
    };
    window.localStorage.setItem(WORKSPACE_TABS_STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

const initial = loadPersistedTabs();

export const useWorkspaceTabsStore = create<WorkspaceTabsState>((set, get) => ({
  tabs: initial.tabs,
  activeTabKey: initial.activeTabKey,

  openTab: (tab: WorkspaceTab) => {
    set((state) => {
      const existingIndex = state.tabs.findIndex((t) => t.key === tab.key);
      let nextTabs: WorkspaceTab[];
      if (existingIndex >= 0) {
        nextTabs = state.tabs.map((t, idx) =>
          idx === existingIndex
            ? {
                ...t,
                ...tab,
                title: tab.title || t.title,
                projectName: tab.projectName ?? t.projectName,
                projectCwd: tab.projectCwd ?? t.projectCwd,
                faviconPath: tab.faviconPath ?? t.faviconPath,
              }
            : t,
        );
      } else {
        nextTabs = [tab, ...state.tabs];
      }
      savePersistedTabs(nextTabs, tab.key);
      return { tabs: nextTabs, activeTabKey: tab.key };
    });
  },

  closeTab: (tabKey: string) => {
    const state = get();
    const index = state.tabs.findIndex((t) => t.key === tabKey);
    if (index === -1) return null;

    const isClosingActive = state.activeTabKey === tabKey;
    const nextTabs = state.tabs.filter((t) => t.key !== tabKey);
    let nextActiveTab: WorkspaceTab | null = null;

    if (isClosingActive) {
      if (nextTabs.length > 0) {
        const nextIndex = Math.min(index, nextTabs.length - 1);
        nextActiveTab = nextTabs[nextIndex] ?? null;
      }
    } else {
      nextActiveTab = state.tabs.find((t) => t.key === state.activeTabKey) ?? null;
    }

    const nextActiveKey = nextActiveTab ? nextActiveTab.key : null;
    savePersistedTabs(nextTabs, nextActiveKey);
    set({ tabs: nextTabs, activeTabKey: nextActiveKey });

    return isClosingActive ? nextActiveTab : null;
  },

  closeOtherTabs: (keepTabKey: string) => {
    set((state) => {
      const exists = state.tabs.some((t) => t.key === keepTabKey);
      if (!exists) return state;
      const nextTabs = state.tabs.filter((t) => t.key === keepTabKey || t.pinned);
      const nextActiveKey = nextTabs.some((t) => t.key === state.activeTabKey)
        ? state.activeTabKey
        : keepTabKey;
      savePersistedTabs(nextTabs, nextActiveKey);
      return { tabs: nextTabs, activeTabKey: nextActiveKey };
    });
  },

  closeTabsToRight: (fromTabKey: string) => {
    set((state) => {
      const index = state.tabs.findIndex((t) => t.key === fromTabKey);
      if (index === -1) return state;
      const nextTabs = state.tabs.filter((t, i) => i <= index || t.pinned);
      const nextActiveKey = nextTabs.some((t) => t.key === state.activeTabKey)
        ? state.activeTabKey
        : fromTabKey;
      savePersistedTabs(nextTabs, nextActiveKey);
      return { tabs: nextTabs, activeTabKey: nextActiveKey };
    });
  },

  closeAllTabs: () => {
    set((state) => {
      const nextTabs = state.tabs.filter((t) => t.pinned);
      const nextActiveKey = nextTabs[0]?.key ?? null;
      savePersistedTabs(nextTabs, nextActiveKey);
      return { tabs: nextTabs, activeTabKey: nextActiveKey };
    });
  },

  reorderTabs: (sourceKey: string, targetKey: string) => {
    set((state) => {
      const sourceIndex = state.tabs.findIndex((t) => t.key === sourceKey);
      const targetIndex = state.tabs.findIndex((t) => t.key === targetKey);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
        return state;
      }
      const tab = state.tabs[sourceIndex];
      if (!tab) return state;
      const nextTabs = [...state.tabs];
      nextTabs.splice(sourceIndex, 1);
      nextTabs.splice(targetIndex, 0, tab);
      savePersistedTabs(nextTabs, state.activeTabKey);
      return { tabs: nextTabs };
    });
  },

  togglePinTab: (tabKey: string) => {
    set((state) => {
      const nextTabs = state.tabs.map((t) => (t.key === tabKey ? { ...t, pinned: !t.pinned } : t));
      savePersistedTabs(nextTabs, state.activeTabKey);
      return { tabs: nextTabs };
    });
  },
}));
