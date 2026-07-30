import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ProjectSettingsDialogTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface ProjectSettingsDialogStore {
  readonly target: ProjectSettingsDialogTarget | null;
  readonly openProjectSettings: (target: ProjectSettingsDialogTarget) => void;
  readonly closeProjectSettings: () => void;
}

/**
 * Project settings live in a dialog rather than a route, so every entry point
 * (both sidebars, context menus, command palette) opens the same surface
 * without navigating away from the thread the user is working in.
 */
export const useProjectSettingsDialogStore = create<ProjectSettingsDialogStore>((set) => ({
  target: null,
  openProjectSettings: (target) => set({ target }),
  closeProjectSettings: () => set({ target: null }),
}));

export function openProjectSettingsDialog(target: ProjectSettingsDialogTarget): void {
  useProjectSettingsDialogStore.getState().openProjectSettings(target);
}

export function closeProjectSettingsDialog(): void {
  useProjectSettingsDialogStore.getState().closeProjectSettings();
}
