import { FolderIcon, PlusIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { ScrollArea } from "../../ui/scroll-area";
import { ProjectRailAvatar } from "./ProjectRailAvatar";
import { ProjectRailTile } from "./ProjectRailTile";
import { PROJECT_RAIL_WIDTH } from "./projectRail.constants";

function resolveRemoteLabel(project: SidebarProjectSnapshot): string | undefined {
  if (project.environmentPresence === "local-only") return undefined;
  const labels = project.remoteEnvironmentLabels;
  return labels.length > 0 ? labels.join(", ") : undefined;
}

/**
 * The Discord-style project column: "all projects" on top, one tile per
 * project, "new project" pinned to the bottom. It is a view over the same
 * project scope the combobox drives, so switching here filters the thread list
 * exactly as the combobox does.
 */
export const ProjectRail = memo(function ProjectRail({
  className,
  projectGroups,
  scopeKey,
  onSelectScope,
  onOpenProjectSettings,
  onAddProject,
}: {
  readonly className?: string | undefined;
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly scopeKey: string | null;
  readonly onSelectScope: (projectKey: string | null) => void;
  readonly onOpenProjectSettings: (
    event: ReactMouseEvent<HTMLElement>,
    project: SidebarProjectSnapshot,
  ) => void;
  readonly onAddProject: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col items-center gap-2 border-r border-sidebar-border py-[var(--sidebar-content-inset)]",
        className,
      )}
      style={{ width: `${PROJECT_RAIL_WIDTH}px` }}
      data-project-rail=""
    >
      <ProjectRailTile
        active={scopeKey === null}
        label="All projects"
        onClick={() => onSelectScope(null)}
      >
        <FolderIcon className={cn("size-5", scopeKey === null && "text-sidebar-foreground")} />
      </ProjectRailTile>

      <span aria-hidden="true" className="h-px w-6 shrink-0 rounded-full bg-sidebar-border" />

      <ScrollArea hideScrollbars className="min-h-0 flex-1">
        <div className="flex flex-col items-center gap-2">
          {projectGroups.map((project) => (
            <ProjectRailTile
              key={project.projectKey}
              active={scopeKey === project.projectKey}
              label={project.displayName}
              secondaryLabel={resolveRemoteLabel(project)}
              onClick={() => onSelectScope(project.projectKey)}
              onContextMenu={(event) => onOpenProjectSettings(event, project)}
            >
              <ProjectRailAvatar project={project} />
            </ProjectRailTile>
          ))}
        </div>
      </ScrollArea>

      <ProjectRailTile active={false} label="New project" onClick={onAddProject}>
        <PlusIcon className="size-5 text-sidebar-muted-foreground" />
      </ProjectRailTile>
    </div>
  );
});
