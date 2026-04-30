import { scopedProjectKey } from "@forma/client-runtime";
import type {
  PreviewControlsBridgeStatus,
  PreviewProjectEvent,
  PreviewProjectInspectionResult,
  PreviewResolveTargetResult,
  PreviewTargetKind,
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

export interface PreviewWorkspaceProjectState {
  currentTargetKind: PreviewTargetKind | null;
  currentRelativePath: string | null;
  currentComponentRelativePath: string | null;
  currentStoryRelativePath: string | null;
  currentStoryId: string | null;
  currentVariantIndex: number;
  ephemeralArgs: Record<string, unknown>;
  runtimeState: PreviewProjectEvent | null;
  storyChoices: PreviewResolveTargetResult extends infer TResult
    ? TResult extends { status: "needsStoryChoice"; storyChoices: infer TChoices }
      ? TChoices
      : never
    : never;
  resolution: PreviewResolveTargetResult | null;
  inspection: PreviewProjectInspectionResult | null;
  controlsBridgeStatus: PreviewControlsBridgeStatus | null;
  controls: PreviewControlDescriptor[];
  accessToken: string | null;
}

interface PreviewWorkspaceStore {
  activeProjectRef: ScopedProjectRef | null;
  projectStateByKey: Record<string, PreviewWorkspaceProjectState>;
  setActiveProjectRef: (projectRef: ScopedProjectRef | null) => void;
  patchProjectState: (
    projectRef: ScopedProjectRef,
    patch: Partial<PreviewWorkspaceProjectState>,
  ) => void;
  resetProjectState: (projectRef: ScopedProjectRef) => void;
}

function createDefaultProjectState(): PreviewWorkspaceProjectState {
  return {
    currentTargetKind: null,
    currentRelativePath: null,
    currentComponentRelativePath: null,
    currentStoryRelativePath: null,
    currentStoryId: null,
    currentVariantIndex: 0,
    ephemeralArgs: {},
    runtimeState: null,
    storyChoices: [],
    resolution: null,
    inspection: null,
    controlsBridgeStatus: null,
    controls: [],
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
  patchProjectState: (projectRef, patch) =>
    set((state) => ({
      projectStateByKey: {
        ...state.projectStateByKey,
        [scopedProjectKey(projectRef)]: {
          ...getProjectStateRecord(state.projectStateByKey, projectRef),
          ...patch,
        },
      },
    })),
  resetProjectState: (projectRef) =>
    set((state) => ({
      projectStateByKey: {
        ...state.projectStateByKey,
        [scopedProjectKey(projectRef)]: createDefaultProjectState(),
      },
    })),
}));
