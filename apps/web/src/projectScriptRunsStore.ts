import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import type { ProjectScriptRun, ProjectScriptRunPatch } from "./projectScriptRuns";

interface ProjectScriptRunsStore {
  readonly runs: Record<string, ProjectScriptRun>;
  readonly selectedRunId: string | null;
  readonly pendingStopRunIds: ReadonlySet<string>;
  readonly pendingLaunchKeys: ReadonlySet<string>;
  readonly startRun: (run: ProjectScriptRun) => void;
  readonly updateRun: (runId: string, patch: ProjectScriptRunPatch) => void;
  readonly removeRun: (runId: string) => void;
  readonly clearFinished: () => void;
  readonly selectRun: (runId: string | null) => void;
  readonly beginStop: (runId: string) => void;
  readonly endStop: (runId: string) => void;
  readonly beginLaunch: (key: string) => boolean;
  readonly endLaunch: (key: string) => void;
}

const PROJECT_SCRIPT_RUNS_STORAGE_KEY = "t3code:project-script-runs:v1";

export const useProjectScriptRunsStore = create<ProjectScriptRunsStore>()(
  persist(
    (set, get) => ({
      runs: {},
      selectedRunId: null,
      pendingStopRunIds: new Set(),
      pendingLaunchKeys: new Set(),
      startRun: (run) => set((state) => ({ runs: { ...state.runs, [run.id]: run } })),
      updateRun: (runId, patch) =>
        set((state) => {
          const run = state.runs[runId];
          if (run === undefined) return state;
          return { runs: { ...state.runs, [runId]: { ...run, ...patch } } };
        }),
      removeRun: (runId) =>
        set((state) => {
          if (state.runs[runId] === undefined) return state;
          const runs = { ...state.runs };
          delete runs[runId];
          return {
            runs,
            selectedRunId: state.selectedRunId === runId ? null : state.selectedRunId,
          };
        }),
      clearFinished: () =>
        set((state) => ({
          runs: Object.fromEntries(
            Object.entries(state.runs).filter(
              ([, run]) => run.status === "starting" || run.status === "running",
            ),
          ),
          selectedRunId:
            state.selectedRunId !== null &&
            state.runs[state.selectedRunId] !== undefined &&
            (state.runs[state.selectedRunId]!.status === "starting" ||
              state.runs[state.selectedRunId]!.status === "running")
              ? state.selectedRunId
              : null,
        })),
      selectRun: (runId) => set({ selectedRunId: runId }),
      beginStop: (runId) =>
        set((state) => {
          if (state.pendingStopRunIds.has(runId)) return state;
          const pendingStopRunIds = new Set(state.pendingStopRunIds);
          pendingStopRunIds.add(runId);
          return { pendingStopRunIds };
        }),
      endStop: (runId) =>
        set((state) => {
          if (!state.pendingStopRunIds.has(runId)) return state;
          const pendingStopRunIds = new Set(state.pendingStopRunIds);
          pendingStopRunIds.delete(runId);
          return { pendingStopRunIds };
        }),
      beginLaunch: (key) => {
        if (get().pendingLaunchKeys.has(key)) return false;
        const pendingLaunchKeys = new Set(get().pendingLaunchKeys);
        pendingLaunchKeys.add(key);
        set({ pendingLaunchKeys });
        return true;
      },
      endLaunch: (key) =>
        set((state) => {
          if (!state.pendingLaunchKeys.has(key)) return state;
          const pendingLaunchKeys = new Set(state.pendingLaunchKeys);
          pendingLaunchKeys.delete(key);
          return { pendingLaunchKeys };
        }),
    }),
    {
      name: PROJECT_SCRIPT_RUNS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.sessionStorage : undefined),
      ),
      partialize: (state) => ({ runs: state.runs }),
    },
  ),
);
