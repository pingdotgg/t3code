import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isPiExternalProjectId } from "@t3tools/client-runtime/state/pi-native";
import type { ScopedProjectRef } from "@t3tools/contracts";

import type { Project } from "../types";

export function resolveNewThreadProject(
  projects: ReadonlyArray<Project>,
  projectRef: ScopedProjectRef,
):
  | { readonly kind: "missing"; readonly projectRef: ScopedProjectRef }
  | { readonly kind: "internal"; readonly project: Project; readonly projectRef: ScopedProjectRef }
  | { readonly kind: "promote"; readonly project: Project } {
  const project = projects.find(
    (candidate) =>
      candidate.id === projectRef.projectId && candidate.environmentId === projectRef.environmentId,
  );
  if (!project) return { kind: "missing", projectRef };
  if (!isPiExternalProjectId(project.id)) return { kind: "internal", project, projectRef };

  const internalProject = projects.find(
    (candidate) =>
      candidate.environmentId === project.environmentId &&
      !isPiExternalProjectId(candidate.id) &&
      candidate.workspaceRoot === project.workspaceRoot,
  );
  return internalProject
    ? {
        kind: "internal",
        project: internalProject,
        projectRef: scopeProjectRef(internalProject.environmentId, internalProject.id),
      }
    : { kind: "promote", project };
}
