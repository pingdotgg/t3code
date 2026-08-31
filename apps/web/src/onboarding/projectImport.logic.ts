import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import type { AgentSessionProjectCandidate, EnvironmentId, ProjectId } from "@t3tools/contracts";

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Existing projects still need their agent history imported, so every scan candidate is offered. */
export function partitionOnboardingProjects(
  candidates: ReadonlyArray<AgentSessionProjectCandidate>,
  now = Date.now(),
) {
  const cutoff = now - RECENT_PROJECT_WINDOW_MS;

  return {
    available: candidates,
    recent: candidates.filter(
      (candidate) =>
        candidate.lastActiveAt !== null && Date.parse(candidate.lastActiveAt) >= cutoff,
    ),
  };
}

/** Resolve the active project for a scanned root. This recovers retries after a project was created. */
export function resolveOnboardingProjectId(
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>,
  environmentId: EnvironmentId,
  workspaceRoot: string,
  scannedProjectId?: ProjectId,
): ProjectId | null {
  const environmentProjects = projects.filter((project) => project.environmentId === environmentId);
  const currentRootMatch = findProjectByPath(environmentProjects, workspaceRoot);
  if (currentRootMatch !== undefined) return currentRootMatch.id;
  if (
    scannedProjectId !== undefined &&
    environmentProjects.some((project) => project.id === scannedProjectId)
  ) {
    return scannedProjectId;
  }
  return null;
}
