import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";

import { cn } from "~/lib/utils";

import { isGenericProjectIcon, selectProjectIcon } from "../../../projectIconModel";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { ProjectFavicon, useProjectFaviconAsset } from "../../ProjectFavicon";
import { resolveProjectInitials, resolveProjectTileColorClassName } from "./projectRailInitials";

/**
 * What a rail tile shows, in falling order of how much it says about the
 * project: its favicon, an icon the user picked, an icon the model actually
 * recognized from the name, and otherwise the project's initials. The model
 * hands out a generic code glyph for names it cannot place, and a rail of
 * identical glyphs is unreadable — initials at least differ per project.
 */
export function ProjectRailAvatar({ project }: { project: SidebarProjectSnapshot }) {
  const faviconState = useProjectFaviconAsset({
    environmentId: project.environmentId,
    cwd: project.workspaceRoot,
    faviconPath: project.faviconPath,
  });
  // A resolved URL can still be the server's "no favicon here" marker, which
  // ProjectFavicon itself treats as absent.
  const hasFavicon =
    faviconState._tag === "Success" && !isProjectFaviconFallbackUrl(faviconState.url);
  const hasChosenIcon = project.projectIcon != null;
  const isRecognizedName = !isGenericProjectIcon(
    selectProjectIcon(project.title, project.workspaceRoot),
  );

  if (hasFavicon || hasChosenIcon || isRecognizedName) {
    return (
      <ProjectFavicon
        environmentId={project.environmentId}
        cwd={project.workspaceRoot}
        projectName={project.title}
        faviconPath={project.faviconPath}
        projectIcon={project.projectIcon}
        className="size-5"
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "text-[0.6875rem] font-semibold leading-none tracking-tight",
        resolveProjectTileColorClassName(project.title, project.workspaceRoot),
      )}
    >
      {resolveProjectInitials(project.displayName)}
    </span>
  );
}
