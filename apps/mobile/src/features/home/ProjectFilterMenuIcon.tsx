import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView } from "../../components/ui/AppSymbol";

/** A project filter row's icon; `null` is "All projects". */
export function renderProjectFilterMenuIcon(project: EnvironmentProject | null, size: number) {
  return project ? (
    <ProjectFavicon
      environmentId={project.environmentId}
      faviconPath={project.faviconPath}
      projectIcon={project.projectIcon}
      projectTitle={project.title}
      size={size}
      workspaceRoot={project.workspaceRoot}
    />
  ) : (
    <SymbolView
      name={{ ios: "folder", android: "folder" }}
      size={size}
      tintColorClassName="accent-foreground"
      type="monochrome"
    />
  );
}
