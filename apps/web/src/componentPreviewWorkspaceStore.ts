/**
 * Project-scoped state for the component preview harness surface.
 *
 * Unrelated to the desktop webview browser preview (`previewStateStore.ts`).
 */
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type {
  ComponentPreviewProjectEvent,
  ComponentPreviewProjectInspectionResult,
  ComponentPreviewResolveTargetResult,
  ComponentPreviewScenarioEntry,
  ScopedProjectRef,
} from "@t3tools/contracts";
import { create } from "zustand";
import type { PreviewFeedbackAnnotation } from "./previewFeedback";

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
  currentScenarioChoices: ComponentPreviewScenarioEntry[];
  controls: PreviewControlDescriptor[];
  lastAppliedCommandId: number;
}

export interface PreviewFileSessionState {
  previewFileRelativePath: string;
  selectedScenarioId: string | null;
  confirmedArgOverrides: Record<string, unknown>;
  draftArgOverrides: Record<string, unknown>;
  feedbackAnnotations: PreviewFeedbackAnnotation[];
  updatedAt: string;
}

export interface ComponentPreviewProjectState {
  currentRelativePath: string | null;
  currentPreviewFileRelativePath: string | null;
  runtimeSnapshot: PreviewRuntimeSnapshot | null;
  sessionsByPreviewFilePath: Record<string, PreviewFileSessionState>;
  runtimeState: ComponentPreviewProjectEvent | null;
  resolution: ComponentPreviewResolveTargetResult | null;
  inspection: ComponentPreviewProjectInspectionResult | null;
  accessToken: string | null;
}

interface ComponentPreviewWorkspaceStore {
  activeProjectRef: ScopedProjectRef | null;
  projectStateByKey: Record<string, ComponentPreviewProjectState>;
  setActiveProjectRef: (projectRef: ScopedProjectRef | null) => void;
  updateProjectState: (
    projectRef: ScopedProjectRef,
    updater: (state: ComponentPreviewProjectState) => ComponentPreviewProjectState,
  ) => void;
  patchProjectState: (
    projectRef: ScopedProjectRef,
    patch: Partial<ComponentPreviewProjectState>,
  ) => void;
  resetProjectState: (projectRef: ScopedProjectRef) => void;
}

function createDefaultProjectState(): ComponentPreviewProjectState {
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
  projectStateByKey: Record<string, ComponentPreviewProjectState>,
  projectRef: ScopedProjectRef,
): ComponentPreviewProjectState {
  return projectStateByKey[scopedProjectKey(projectRef)] ?? createDefaultProjectState();
}

export const useComponentPreviewWorkspaceStore = create<ComponentPreviewWorkspaceStore>((set) => ({
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
