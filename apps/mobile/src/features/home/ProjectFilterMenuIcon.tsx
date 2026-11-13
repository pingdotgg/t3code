import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";

export function ProjectFilterMenuIcon(props: { readonly project: EnvironmentProject }) {
  const { iconSize } = useAndroidControlSizing();
  return (
    <ProjectFavicon
      environmentId={props.project.environmentId}
      faviconPath={props.project.faviconPath}
      projectIcon={props.project.projectIcon}
      projectTitle={props.project.title}
      size={iconSize}
      workspaceRoot={props.project.workspaceRoot}
    />
  );
}
