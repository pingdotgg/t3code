import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { resolveAndroidProjectFilterProject } from "./android-home-list-filter-menu";
import type { HomeListFilterMenuProject } from "./home-list-filter-menu";

export function AndroidProjectFilterIcon(props: {
  readonly action: MenuAction;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
}): ReactNode {
  const iconColor = useThemeColor("--color-icon");
  if (props.action.id === "project:all") {
    return <SymbolView name="folder" size={18} tintColor={iconColor} type="monochrome" />;
  }

  const project = resolveAndroidProjectFilterProject(props.action.id, props.projects);
  if (project === null) return null;

  return (
    <ProjectFavicon
      environmentId={project.environmentId}
      faviconPath={project.faviconPath}
      projectTitle={project.label}
      size={18}
      workspaceRoot={project.workspaceRoot}
    />
  );
}
