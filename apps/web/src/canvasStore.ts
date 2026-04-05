/**
 * Canvas Store — Zustand state for Niri-style spatial canvas navigation.
 *
 * Manages the 2D position (project row × thread column), mode switching
 * (navigate / overview / launcher), column width presets, and per-project
 * thread pagination cursors.
 */
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import {
  COLUMN_WIDTH_PRESETS,
  DEFAULT_COLUMN_WIDTH_PRESET,
  type ColumnWidthPreset,
} from "./lib/springProfiles";
import { type SidebarThreadSummary, type Project } from "./types";

// ── Types ───────────────────────────────────────────────────────────

export type CanvasMode = "navigate" | "overview" | "launcher";

export interface ProjectThreadCursor {
  loaded: number;
  hasMore: boolean;
  loading: boolean;
}

// ── State ───────────────────────────────────────────────────────────

export interface CanvasState {
  /** Whether canvas mode is enabled (vs. sidebar mode). */
  enabled: boolean;

  /** Current canvas mode. */
  mode: CanvasMode;

  /** Y-axis: focused project row index. */
  focusedProjectIndex: number;

  /** X-axis: focused thread column index (0 = newest). */
  focusedThreadIndex: number;

  /** Resolved project ID at the focused row. */
  focusedProjectId: ProjectId | null;

  /** Resolved thread ID at the focused column. */
  focusedThreadId: ThreadId | null;

  /** Column width as fraction of viewport width. */
  columnWidthPreset: ColumnWidthPreset;

  /** Overview mode cursor — project axis. */
  overviewCursorProject: number;

  /** Overview mode cursor — thread axis. */
  overviewCursorThread: number;

  /** Launcher search query. */
  launcherQuery: string;

  /** Launcher selected result index. */
  launcherSelectedIndex: number;

  /** Per-project thread loading state for "show more" at right edge. */
  projectThreadCursors: Record<string, ProjectThreadCursor>;

  /** Previous project index for Mod+TAB toggle behavior. */
  previousProjectIndex: number | null;
}

const initialState: CanvasState = {
  enabled: false,
  mode: "navigate",
  focusedProjectIndex: 0,
  focusedThreadIndex: 0,
  focusedProjectId: null,
  focusedThreadId: null,
  columnWidthPreset: DEFAULT_COLUMN_WIDTH_PRESET,
  overviewCursorProject: 0,
  overviewCursorThread: 0,
  launcherQuery: "",
  launcherSelectedIndex: 0,
  projectThreadCursors: {},
  previousProjectIndex: null,
};

// ── Helpers ─────────────────────────────────────────────────────────

/** External data accessors — set once by CanvasShell on mount. */
let _getProjects: () => Project[] = () => [];
let _getThreadsForProject: (projectId: ProjectId | null) => SidebarThreadSummary[] = () => [];

export function setCanvasDataAccessors(
  getProjects: () => Project[],
  getThreadsForProject: (projectId: ProjectId | null) => SidebarThreadSummary[],
): void {
  _getProjects = getProjects;
  _getThreadsForProject = getThreadsForProject;
}

function resolveProjectId(state: CanvasState): ProjectId | null {
  const projects = _getProjects();
  return projects[state.focusedProjectIndex]?.id ?? null;
}

function resolveThreadId(state: CanvasState, projectId: ProjectId | null): ThreadId | null {
  if (!projectId) return null;
  const threads = _getThreadsForProject(projectId);
  return threads[state.focusedThreadIndex]?.id ?? null;
}

function syncFocusIds(state: CanvasState): Partial<CanvasState> {
  const projectId = resolveProjectId(state);
  const threadId = resolveThreadId(state, projectId);
  if (state.focusedProjectId === projectId && state.focusedThreadId === threadId) {
    return {};
  }
  return { focusedProjectId: projectId, focusedThreadId: threadId };
}

// ── Store ───────────────────────────────────────────────────────────

export interface CanvasActions {
  setEnabled: (enabled: boolean) => void;

  // Navigation
  navigateLeft: () => void;
  navigateRight: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  jumpToProject: (targetIndex: number) => void;
  jumpToThread: (projectId: ProjectId, threadId: ThreadId) => void;
  togglePreviousProject: () => void;

  // Focus sync (called when external data changes)
  syncFocus: () => void;

  // Modes
  toggleOverview: () => void;
  openLauncher: () => void;
  closeLauncher: () => void;
  exitOverlay: () => void;

  // Launcher
  setLauncherQuery: (query: string) => void;
  setLauncherSelectedIndex: (index: number) => void;

  // Layout
  cycleColumnWidth: () => void;
  setColumnWidthPreset: (preset: ColumnWidthPreset) => void;

  // Pagination
  setProjectThreadCursor: (projectId: string, cursor: Partial<ProjectThreadCursor>) => void;
}

export type CanvasStore = CanvasState & CanvasActions;

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  ...initialState,

  setEnabled: (enabled) => set({ enabled }),

  // ── Navigation ──────────────────────────────────────────────────

  navigateLeft: () => {
    const { focusedThreadIndex, mode } = get();
    if (mode !== "navigate") return;
    if (focusedThreadIndex <= 0) return; // boundary: do nothing

    const nextIndex = focusedThreadIndex - 1;
    const base = { focusedThreadIndex: nextIndex };
    const next = { ...get(), ...base };
    set({ ...base, ...syncFocusIds(next) });
  },

  navigateRight: () => {
    const state = get();
    if (state.mode !== "navigate") return;

    const projectId = state.focusedProjectId;
    const threads = _getThreadsForProject(projectId);

    if (state.focusedThreadIndex >= threads.length - 1) {
      // At the edge — try to load more if available
      if (projectId) {
        const cursor = state.projectThreadCursors[projectId];
        if (cursor?.hasMore && !cursor.loading) {
          // Signal that we want more threads — CanvasShell handles the RPC
          set({
            projectThreadCursors: {
              ...state.projectThreadCursors,
              [projectId]: { ...cursor, loading: true },
            },
          });
        }
      }
      return; // boundary: can't navigate into unloaded content
    }

    const nextIndex = state.focusedThreadIndex + 1;
    const base = { focusedThreadIndex: nextIndex };
    const next = { ...state, ...base };
    set({ ...base, ...syncFocusIds(next) });
  },

  navigateUp: () => {
    const { focusedProjectIndex, mode } = get();
    if (mode !== "navigate") return;
    if (focusedProjectIndex <= 0) return; // boundary: do nothing

    const nextIndex = focusedProjectIndex - 1;
    const base = { focusedProjectIndex: nextIndex, focusedThreadIndex: 0 };
    const next = { ...get(), ...base };
    set({
      ...base,
      previousProjectIndex: focusedProjectIndex,
      ...syncFocusIds(next),
    });
  },

  navigateDown: () => {
    const state = get();
    if (state.mode !== "navigate") return;

    const projects = _getProjects();
    if (state.focusedProjectIndex >= projects.length - 1) return; // boundary

    const nextIndex = state.focusedProjectIndex + 1;
    const base = { focusedProjectIndex: nextIndex, focusedThreadIndex: 0 };
    const next = { ...state, ...base };
    set({
      ...base,
      previousProjectIndex: state.focusedProjectIndex,
      ...syncFocusIds(next),
    });
  },

  jumpToProject: (targetIndex) => {
    const state = get();
    const projects = _getProjects();
    const projectCount = projects.length;

    // If pressing same number and on a non-project row, toggle back
    if (targetIndex === state.focusedProjectIndex && state.focusedProjectIndex >= projectCount) {
      if (state.previousProjectIndex !== null) {
        const base = {
          focusedProjectIndex: state.previousProjectIndex,
          previousProjectIndex: state.focusedProjectIndex,
          focusedThreadIndex: 0,
        };
        const next = { ...state, ...base };
        set({ ...base, ...syncFocusIds(next) });
        return;
      }
    }

    // Clamp to valid range (projectCount = one past last = "new project" row)
    const resolvedIndex = Math.min(targetIndex, projectCount);

    const base = {
      previousProjectIndex: state.focusedProjectIndex,
      focusedProjectIndex: resolvedIndex,
      focusedThreadIndex: 0,
    };
    const next = { ...state, ...base };
    set({ ...base, ...syncFocusIds(next) });
  },

  jumpToThread: (projectId, threadId) => {
    const state = get();
    const projects = _getProjects();
    const projectIndex = projects.findIndex((p) => p.id === projectId);
    if (projectIndex === -1) return;

    const threads = _getThreadsForProject(projectId);
    const threadIndex = threads.findIndex((t) => t.id === threadId);
    if (threadIndex === -1) return;

    set({
      previousProjectIndex: state.focusedProjectIndex,
      focusedProjectIndex: projectIndex,
      focusedThreadIndex: threadIndex,
      focusedProjectId: projectId,
      focusedThreadId: threadId,
      mode: "navigate",
      launcherQuery: "",
      launcherSelectedIndex: 0,
    });
  },

  togglePreviousProject: () => {
    const state = get();
    if (state.previousProjectIndex === null) return;

    const base = {
      focusedProjectIndex: state.previousProjectIndex,
      previousProjectIndex: state.focusedProjectIndex,
      focusedThreadIndex: 0,
    };
    const next = { ...state, ...base };
    set({ ...base, ...syncFocusIds(next) });
  },

  syncFocus: () => {
    const state = get();
    const updates = syncFocusIds(state);
    if (Object.keys(updates).length > 0) {
      set(updates);
    }
  },

  // ── Modes ───────────────────────────────────────────────────────

  toggleOverview: () => {
    const { mode, focusedProjectIndex, focusedThreadIndex } = get();
    if (mode === "overview") {
      set({ mode: "navigate" });
    } else {
      set({
        mode: "overview",
        overviewCursorProject: focusedProjectIndex,
        overviewCursorThread: focusedThreadIndex,
      });
    }
  },

  openLauncher: () => {
    set({ mode: "launcher", launcherQuery: "", launcherSelectedIndex: 0 });
  },

  closeLauncher: () => {
    set({ mode: "navigate", launcherQuery: "", launcherSelectedIndex: 0 });
  },

  exitOverlay: () => {
    const { mode } = get();
    if (mode === "launcher") set({ mode: "navigate", launcherQuery: "", launcherSelectedIndex: 0 });
    else if (mode === "overview") set({ mode: "navigate" });
  },

  // ── Launcher ────────────────────────────────────────────────────

  setLauncherQuery: (query) => set({ launcherQuery: query, launcherSelectedIndex: 0 }),
  setLauncherSelectedIndex: (index) => set({ launcherSelectedIndex: index }),

  // ── Layout ──────────────────────────────────────────────────────

  cycleColumnWidth: () => {
    const { columnWidthPreset } = get();
    const currentIndex = COLUMN_WIDTH_PRESETS.indexOf(columnWidthPreset);
    const nextIndex = (currentIndex + 1) % COLUMN_WIDTH_PRESETS.length;
    set({ columnWidthPreset: COLUMN_WIDTH_PRESETS[nextIndex]! });
  },

  setColumnWidthPreset: (preset) => set({ columnWidthPreset: preset }),

  // ── Pagination ──────────────────────────────────────────────────

  setProjectThreadCursor: (projectId, cursor) => {
    const { projectThreadCursors } = get();
    const existing = projectThreadCursors[projectId] ?? {
      loaded: 0,
      hasMore: true,
      loading: false,
    };
    set({
      projectThreadCursors: {
        ...projectThreadCursors,
        [projectId]: { ...existing, ...cursor },
      },
    });
  },
}));

// ── Selectors ─────────────────────────────────────────────────────

export function selectCanvasEnabled(state: CanvasStore): boolean {
  return state.enabled;
}

export function selectCanvasMode(state: CanvasStore): CanvasMode {
  return state.mode;
}

export function selectCanvasPosition(state: CanvasStore) {
  return {
    projectIndex: state.focusedProjectIndex,
    threadIndex: state.focusedThreadIndex,
    projectId: state.focusedProjectId,
    threadId: state.focusedThreadId,
  };
}
