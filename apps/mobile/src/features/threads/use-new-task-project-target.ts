import {
  buildProjectGroups,
  resolveNewThreadProjectRef,
} from "@t3tools/client-runtime/state/project-grouping";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useCallback, useMemo } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";

export function useNewTaskProjectTarget() {
  const projects = useProjects();
  const configs = useServerConfigs();
  const settings = useMobileProjectGroupingSettings();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const projectsByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          project,
        ]),
      ),
    [projects],
  );
  const membersByProjectKey = useMemo(
    () =>
      new Map(
        buildProjectGroups({ projects, settings }).flatMap((group) => {
          const members = group.members.map((member) => member.project);
          return group.memberProjectRefs.map((ref) => [scopedProjectKey(ref), members] as const);
        }),
      ),
    [projects, settings],
  );
  const settingsByEnvironment = useMemo(
    () => new Map([...configs].map(([id, config]) => [id, config.settings])),
    [configs],
  );
  const connectedEnvironmentIds = useMemo(
    () =>
      new Set(
        connectedEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId),
      ),
    [connectedEnvironments],
  );
  return useCallback(
    (
      project: EnvironmentProject,
      options?: { readonly manualProjectRef?: ScopedProjectRef | null },
    ) => {
      const projectRef = scopeProjectRef(project.environmentId, project.id);
      const members = membersByProjectKey.get(scopedProjectKey(projectRef)) ?? [];
      const manualProjectRef = options?.manualProjectRef;
      const target = resolveNewThreadProjectRef({
        members,
        manualProjectRef:
          manualProjectRef &&
          membersByProjectKey.get(scopedProjectKey(manualProjectRef)) === members
            ? manualProjectRef
            : null,
        settingsByEnvironment,
        connectedEnvironmentIds,
        contextProjectRef: projectRef,
      });
      return target.projectRef
        ? (projectsByKey.get(scopedProjectKey(target.projectRef)) ?? project)
        : project;
    },
    [connectedEnvironmentIds, membersByProjectKey, projectsByKey, settingsByEnvironment],
  );
}
