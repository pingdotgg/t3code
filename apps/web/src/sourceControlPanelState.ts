import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { markRightPanelUsed } from "./rightPanelGesture";
import {
  closeWorkspaceSourceControlPanel,
  openWorkspaceSourceControlPanel,
  useWorkspaceFilePanelState,
} from "./workspaceFilePreview";

export type SourceControlPanelViewMode = "tree" | "list";

interface SourceControlPanelWorkspaceViewState {
  readonly collapsedDirs: ReadonlySet<string>;
  readonly viewMode: SourceControlPanelViewMode;
}

interface SourceControlPanelState {
  /**
   * Draft commit message, persisted across panel open/close so the user does
   * not lose what they typed when they hop between panels.
   */
  commitMessage: string;
  scrollTopByWorkspaceKey: Readonly<Record<string, number>>;
  viewStateByWorkspaceKey: Readonly<Record<string, SourceControlPanelWorkspaceViewState>>;
  setCommitMessage: (commitMessage: string) => void;
  setCollapsedDirs: (workspaceKey: string, collapsedDirs: ReadonlySet<string>) => void;
  setScrollTop: (workspaceKey: string, scrollTop: number) => void;
  setViewMode: (workspaceKey: string, viewMode: SourceControlPanelViewMode) => void;
}

const DEFAULT_WORKSPACE_VIEW_STATE: SourceControlPanelWorkspaceViewState = {
  collapsedDirs: new Set(),
  viewMode: "tree",
};

function getWorkspaceViewState(
  state: SourceControlPanelState,
  workspaceKey: string,
): SourceControlPanelWorkspaceViewState {
  return state.viewStateByWorkspaceKey[workspaceKey] ?? DEFAULT_WORKSPACE_VIEW_STATE;
}

function sameSetValues(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

const useSourceControlPanelStore = create<SourceControlPanelState>((set) => ({
  commitMessage: "",
  scrollTopByWorkspaceKey: {},
  viewStateByWorkspaceKey: {},
  setCommitMessage: (commitMessage) => set({ commitMessage }),
  setCollapsedDirs: (workspaceKey, collapsedDirs) =>
    set((state) => {
      const current = getWorkspaceViewState(state, workspaceKey);
      if (sameSetValues(current.collapsedDirs, collapsedDirs)) {
        return state;
      }
      return {
        viewStateByWorkspaceKey: {
          ...state.viewStateByWorkspaceKey,
          [workspaceKey]: {
            ...current,
            collapsedDirs: new Set(collapsedDirs),
          },
        },
      };
    }),
  setScrollTop: (workspaceKey, scrollTop) =>
    set((state) => {
      const nextScrollTop = Math.max(0, Math.round(scrollTop));
      if (state.scrollTopByWorkspaceKey[workspaceKey] === nextScrollTop) {
        return state;
      }
      return {
        scrollTopByWorkspaceKey: {
          ...state.scrollTopByWorkspaceKey,
          [workspaceKey]: nextScrollTop,
        },
      };
    }),
  setViewMode: (workspaceKey, viewMode) =>
    set((state) => {
      const current = getWorkspaceViewState(state, workspaceKey);
      if (current.viewMode === viewMode) {
        return state;
      }
      return {
        viewStateByWorkspaceKey: {
          ...state.viewStateByWorkspaceKey,
          [workspaceKey]: {
            ...current,
            viewMode,
          },
        },
      };
    }),
}));

export function sourceControlPanelScrollKey(input: {
  environmentId: EnvironmentId | null | undefined;
  cwd: string | null | undefined;
}): string | null {
  return input.environmentId && input.cwd ? `${input.environmentId}\n${input.cwd}` : null;
}

export function readSourceControlPanelScrollTop(workspaceKey: string | null): number {
  if (!workspaceKey) {
    return 0;
  }
  return useSourceControlPanelStore.getState().scrollTopByWorkspaceKey[workspaceKey] ?? 0;
}

export function recordSourceControlPanelScrollTop(
  workspaceKey: string | null,
  scrollTop: number,
): void {
  if (!workspaceKey) {
    return;
  }
  useSourceControlPanelStore.getState().setScrollTop(workspaceKey, scrollTop);
}

export function recordSourceControlPanelCollapsedDirs(
  workspaceKey: string | null,
  collapsedDirs: ReadonlySet<string>,
): void {
  if (!workspaceKey) {
    return;
  }
  useSourceControlPanelStore.getState().setCollapsedDirs(workspaceKey, collapsedDirs);
}

export function recordSourceControlPanelViewMode(
  workspaceKey: string | null,
  viewMode: SourceControlPanelViewMode,
): void {
  if (!workspaceKey) {
    return;
  }
  useSourceControlPanelStore.getState().setViewMode(workspaceKey, viewMode);
}

export function openSourceControlPanel(): void {
  markRightPanelUsed("source-control");
  openWorkspaceSourceControlPanel();
}

export function closeSourceControlPanel(): void {
  closeWorkspaceSourceControlPanel();
}

export function useSourceControlPanelState() {
  const filePanel = useWorkspaceFilePanelState();
  const commitMessage = useSourceControlPanelStore((state) => state.commitMessage);
  return {
    open: filePanel.open && filePanel.view === "source-control",
    commitMessage,
  };
}

export function useSetSourceControlCommitMessage() {
  return useSourceControlPanelStore((state) => state.setCommitMessage);
}

export function useSourceControlPanelWorkspaceViewState(workspaceKey: string | null) {
  return useSourceControlPanelStore((state) =>
    workspaceKey
      ? (state.viewStateByWorkspaceKey[workspaceKey] ?? DEFAULT_WORKSPACE_VIEW_STATE)
      : DEFAULT_WORKSPACE_VIEW_STATE,
  );
}

export function __resetSourceControlPanelStateForTests(): void {
  useSourceControlPanelStore.setState({
    commitMessage: "",
    scrollTopByWorkspaceKey: {},
    viewStateByWorkspaceKey: {},
  });
}
