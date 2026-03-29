import type { ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

interface ProjectBrowserState {
  tabs: BrowserTab[];
  activeTabId: string;
}

const BROWSER_PANEL_STORAGE_KEY = "t3code:browser-panel:v1";

let nextTabId = 1;
function generateTabId(): string {
  return `browser-tab-${Date.now()}-${nextTabId++}`;
}

const DEFAULT_PROJECT_BROWSER_STATE: ProjectBrowserState = {
  tabs: [],
  activeTabId: "",
};

function getProjectState(
  stateByProjectId: Record<ProjectId, ProjectBrowserState>,
  projectId: ProjectId,
): ProjectBrowserState {
  return stateByProjectId[projectId] ?? DEFAULT_PROJECT_BROWSER_STATE;
}

interface BrowserPanelStoreState {
  browserStateByProjectId: Record<ProjectId, ProjectBrowserState>;
  openUrlInProject: (projectId: ProjectId, url: string) => void;
  addTab: (projectId: ProjectId, url?: string) => void;
  closeTab: (projectId: ProjectId, tabId: string) => void;
  setActiveTab: (projectId: ProjectId, tabId: string) => void;
  navigateTab: (projectId: ProjectId, tabId: string, url: string) => void;
  setTabTitle: (projectId: ProjectId, tabId: string, title: string) => void;
}

export const useBrowserPanelStore = create<BrowserPanelStoreState>()(
  persist(
    (set) => {
      const updateProject = (
        projectId: ProjectId,
        updater: (state: ProjectBrowserState) => ProjectBrowserState,
      ) => {
        set((store) => {
          const current = getProjectState(store.browserStateByProjectId, projectId);
          const next = updater(current);
          if (next === current) return store;
          return {
            browserStateByProjectId: {
              ...store.browserStateByProjectId,
              [projectId]: next,
            },
          };
        });
      };

      return {
        browserStateByProjectId: {},

        openUrlInProject: (projectId, url) => {
          updateProject(projectId, (state) => {
            // If there are no tabs, create one with this URL
            if (state.tabs.length === 0) {
              const id = generateTabId();
              return {
                tabs: [{ id, url, title: url }],
                activeTabId: id,
              };
            }
            // Navigate the active tab to this URL
            return {
              ...state,
              tabs: state.tabs.map((tab) =>
                tab.id === state.activeTabId ? { ...tab, url, title: url } : tab,
              ),
            };
          });
        },

        addTab: (projectId, url) => {
          updateProject(projectId, (state) => {
            const id = generateTabId();
            const tabUrl = url ?? "about:blank";
            return {
              tabs: [...state.tabs, { id, url: tabUrl, title: tabUrl }],
              activeTabId: id,
            };
          });
        },

        closeTab: (projectId, tabId) => {
          updateProject(projectId, (state) => {
            const remaining = state.tabs.filter((tab) => tab.id !== tabId);
            if (remaining.length === 0) {
              return DEFAULT_PROJECT_BROWSER_STATE;
            }
            const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
            const nextActiveId =
              state.activeTabId === tabId
                ? (remaining[Math.min(closedIndex, remaining.length - 1)]?.id ?? remaining[0]?.id ?? "")
                : state.activeTabId;
            return { tabs: remaining, activeTabId: nextActiveId };
          });
        },

        setActiveTab: (projectId, tabId) => {
          updateProject(projectId, (state) => {
            if (state.activeTabId === tabId) return state;
            if (!state.tabs.some((tab) => tab.id === tabId)) return state;
            return { ...state, activeTabId: tabId };
          });
        },

        navigateTab: (projectId, tabId, url) => {
          updateProject(projectId, (state) => ({
            ...state,
            tabs: state.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, url, title: url } : tab,
            ),
          }));
        },

        setTabTitle: (projectId, tabId, title) => {
          updateProject(projectId, (state) => ({
            ...state,
            tabs: state.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, title } : tab,
            ),
          }));
        },
      };
    },
    {
      name: BROWSER_PANEL_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        browserStateByProjectId: state.browserStateByProjectId,
      }),
    },
  ),
);

export function selectProjectBrowserState(
  browserStateByProjectId: Record<ProjectId, ProjectBrowserState>,
  projectId: ProjectId,
): ProjectBrowserState {
  return browserStateByProjectId[projectId] ?? DEFAULT_PROJECT_BROWSER_STATE;
}
