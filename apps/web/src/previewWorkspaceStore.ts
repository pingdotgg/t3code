import { scopedProjectKey } from "@forma/client-runtime";
import type {
  PreviewProjectEvent,
  PreviewProjectInspectionResult,
  PreviewResolveTargetResult,
  PreviewScenarioEntry,
  ScopedProjectRef,
} from "@forma/contracts";
import { create } from "zustand";

export type PreviewControlType =
  | "boolean"
  | "number"
  | "range"
  | "text"
  | "color"
  | "date"
  | "object"
  | "select"
  | "multi-select"
  | "radio"
  | "inline-radio"
  | "check"
  | "inline-check";

export interface PreviewControlDescriptor {
  name: string;
  label: string;
  description: string | null;
  type: PreviewControlType;
  value: unknown;
  options?: unknown[] | undefined;
  min?: number | null | undefined;
  max?: number | null | undefined;
  step?: number | null | undefined;
}

export interface PreviewRuntimeSnapshot {
  runtimeInstanceId: string | null;
  currentScenarioId: string | null;
  currentScenarioChoices: PreviewScenarioEntry[];
  controls: PreviewControlDescriptor[];
  lastAppliedCommandId: number;
}

export interface PreviewFileSessionState {
  previewFileRelativePath: string;
  selectedScenarioId: string | null;
  confirmedArgOverrides: Record<string, unknown>;
  draftArgOverrides: Record<string, unknown>;
  updatedAt: string;
}

export interface PreviewWorkspaceProjectState {
  currentRelativePath: string | null;
  currentPreviewFileRelativePath: string | null;
  runtimeSnapshot: PreviewRuntimeSnapshot | null;
  sessionsByPreviewFilePath: Record<string, PreviewFileSessionState>;
  runtimeState: PreviewProjectEvent | null;
  resolution: PreviewResolveTargetResult | null;
  inspection: PreviewProjectInspectionResult | null;
  accessToken: string | null;
}

interface PreviewWorkspaceStore {
  activeProjectRef: ScopedProjectRef | null;
  projectStateByKey: Record<string, PreviewWorkspaceProjectState>;
  setActiveProjectRef: (projectRef: ScopedProjectRef | null) => void;
  updateProjectState: (
    projectRef: ScopedProjectRef,
    updater: (state: PreviewWorkspaceProjectState) => PreviewWorkspaceProjectState,
  ) => void;
  patchProjectState: (
    projectRef: ScopedProjectRef,
    patch: Partial<PreviewWorkspaceProjectState>,
  ) => void;
  resetProjectState: (projectRef: ScopedProjectRef) => void;
}

function createDefaultProjectState(): PreviewWorkspaceProjectState {
  return {
    currentRelativePath: null,
    currentPreviewFileRelativePath: null,
    runtimeSnapshot: null,
    sessionsByPreviewFilePath: {},
    runtimeState: null,
    resolution: null,
    inspection: null,
    accessToken: null,
  };
}

function getProjectStateRecord(
  projectStateByKey: Record<string, PreviewWorkspaceProjectState>,
  projectRef: ScopedProjectRef,
): PreviewWorkspaceProjectState {
  return projectStateByKey[scopedProjectKey(projectRef)] ?? createDefaultProjectState();
}

export const usePreviewWorkspaceStore = create<PreviewWorkspaceStore>((set) => ({
  activeProjectRef: null,
  projectStateByKey: {},
  setActiveProjectRef: (projectRef) =>
    set((state) => {
      if (!projectRef) {
        return { activeProjectRef: null };
      }
      return {
        activeProjectRef: projectRef,
        projectStateByKey: {
          ...state.projectStateByKey,
          [scopedProjectKey(projectRef)]: getProjectStateRecord(
            state.projectStateByKey,
            projectRef,
          ),
        },
      };
    }),
  updateProjectState: (projectRef, updater) =>
    set((state) => ({
      projectStateByKey: {
        ...state.projectStateByKey,
        [scopedProjectKey(projectRef)]: updater(
          getProjectStateRecord(state.projectStateByKey, projectRef),
        ),
      },
    })),
  patchProjectState: (projectRef, patch) =>
    set((state) => {
      const currentState = getProjectStateRecord(state.projectStateByKey, projectRef);
      return {
        projectStateByKey: {
          ...state.projectStateByKey,
          [scopedProjectKey(projectRef)]: {
            ...currentState,
            ...patch,
          },
        },
      };
    }),
  resetProjectState: (projectRef) =>
    set((state) => ({
      projectStateByKey: {
        ...state.projectStateByKey,
        [scopedProjectKey(projectRef)]: createDefaultProjectState(),
      },
    })),
}));
