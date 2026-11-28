import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  extractProjectRepoIdentityKey,
  isTeamHubOnlyServerConfig,
  listAccessibleTeamEnvironments,
  resolveProjectTeamAssignment,
} from "@t3tools/client-runtime/team";
import {
  canMemberAccessTeamEnvironment,
  type EnvironmentId,
  type ProjectId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import type { EnvironmentOption } from "../components/BranchToolbar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useProjects } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useTeamStatesByEnvironment } from "../state/team";
import { useClientSettings } from "./useSettings";

export function useLogicalProjectEnvironments(
  activeProject: EnvironmentProject | null,
  scratchDraft: boolean,
): readonly EnvironmentOption[] {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const teamStates = useTeamStatesByEnvironment();

  if (!activeProject) return [];
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const teamAssignment = resolveProjectTeamAssignment({ project: activeProject, teamStates });
  const isEnvBlockedByTeamAcl = (environmentId: EnvironmentId): boolean => {
    if (
      !teamAssignment ||
      (environmentId === primaryEnvironmentId && environmentId !== teamAssignment.teamEnvironmentId)
    ) {
      return false;
    }
    // Fail closed: TeamService omits restricted environments from non-admin members' snapshot.
    const teamEnv = teamAssignment.teamState.environmentById.get(environmentId);
    if (!teamEnv) return true;
    return !canMemberAccessTeamEnvironment(teamAssignment.teamState.currentMember, teamEnv);
  };
  const envs: EnvironmentOption[] = [];
  const seenEnvIds = new Set<EnvironmentId>();
  const pushEnvironment = (
    environmentId: EnvironmentId,
    projectId: ProjectId | null,
    labelOverride?: string,
  ) => {
    if (seenEnvIds.has(environmentId)) return;
    if (isEnvBlockedByTeamAcl(environmentId)) return;
    const environment = environmentById.get(environmentId) ?? null;
    if (isTeamHubOnlyServerConfig(environment?.serverConfig)) return;
    seenEnvIds.add(environmentId);
    envs.push({
      environmentId,
      projectId,
      label: labelOverride ?? environment?.label ?? environmentId,
      isPrimary: environmentId === primaryEnvironmentId,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
    });
  };
  if (scratchDraft) {
    for (const environment of environments) {
      const scratchRoot = availableScratchWorkspaceRoot(
        environment.connection.phase,
        environment.serverConfig,
      );
      if (scratchRoot === null && environment.environmentId !== activeProject.environmentId)
        continue;
      const scratchProject =
        environment.environmentId === activeProject.environmentId
          ? activeProject
          : allProjects.find(
              (p) =>
                p.environmentId === environment.environmentId && isScratchProject(p, scratchRoot),
            );
      pushEnvironment(environment.environmentId, scratchProject?.id ?? null);
    }
  } else {
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    for (const p of allProjects) {
      if (deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) !== logicalKey) continue;
      pushEnvironment(p.environmentId, p.id);
    }
    if (teamAssignment) {
      const repoKey =
        extractProjectRepoIdentityKey(activeProject.repositoryIdentity) ??
        teamAssignment.assignment.repoIdentityKey;
      for (const teamEnv of listAccessibleTeamEnvironments(teamAssignment.teamState)) {
        if (seenEnvIds.has(teamEnv.environmentId)) continue;
        const matchedProject =
          teamEnv.environmentId === teamAssignment.teamEnvironmentId
            ? allProjects.find(
                (p) =>
                  p.environmentId === teamEnv.environmentId &&
                  p.id === teamAssignment.assignment.projectId,
              )
            : repoKey !== null
              ? allProjects.find(
                  (p) =>
                    p.environmentId === teamEnv.environmentId &&
                    extractProjectRepoIdentityKey(p.repositoryIdentity) === repoKey,
                )
              : undefined;
        pushEnvironment(
          teamEnv.environmentId,
          matchedProject?.id ??
            (teamEnv.environmentId === teamAssignment.teamEnvironmentId
              ? teamAssignment.assignment.projectId
              : null),
          teamEnv.name,
        );
      }
    }
  }
  envs.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return envs;
}
