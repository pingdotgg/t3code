import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "./useSettings";

/** Opens Settings → Project on the group the sidebar shows this project in. */
export function useOpenProjectSettings() {
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useClientSettings(selectProjectGroupingSettings);

  return useCallback(
    (ref: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === ref.environmentId && candidate.id === ref.projectId,
      );
      if (!project) return;
      // Built on click: grouping every project on each render is wasted work.
      const projectKey =
        buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }).get(
          derivePhysicalProjectKey(project),
        ) ?? deriveLogicalProjectKeyFromSettings(project, settings);
      void router.navigate({ to: "/projects/$projectKey", params: { projectKey } });
    },
    [primaryEnvironmentId, projects, router, settings],
  );
}
