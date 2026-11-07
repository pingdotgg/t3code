import { PlusIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

const VISIBLE_PROJECTS = 6;

interface SidebarProjectsSectionProject extends ProjectFaviconProject {
  readonly projectKey: string;
  readonly displayName: string;
}

/** Projects in monocode's "Monos" style: click to scope the thread list, Shift+click to add. */
export function SidebarProjectsSection<P extends SidebarProjectsSectionProject>({
  projects,
  scopedKeys,
  onSelect,
  onToggle,
  onAddProject,
  onProjectSettings,
}: {
  projects: ReadonlyArray<P>;
  scopedKeys: ReadonlyArray<string>;
  onSelect: (projectKey: string | null) => void;
  onToggle: (projectKey: string) => void;
  onAddProject: () => void;
  onProjectSettings: (event: ReactMouseEvent<HTMLElement>, project: P) => void;
}) {
  if (projects.length === 0) return null;
  // Keep a scoped project visible even when it sits past the fold.
  const shown = projects.filter(
    (project, index) => index < VISIBLE_PROJECTS || scopedKeys.includes(project.projectKey),
  );
  return (
    <section aria-label="Projects" className="flex flex-col pb-3">
      <div className="flex h-7 items-center gap-1 px-2 text-xs font-medium text-sidebar-muted-foreground">
        <span className="flex-1">Projects</span>
        <button
          type="button"
          aria-label="Add project"
          onClick={onAddProject}
          className="-mr-0.5 grid size-5 place-items-center rounded-md outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      <ul className="flex flex-col gap-px">
        {shown.map((project) => {
          const selected = scopedKeys.includes(project.projectKey);
          return (
            <li key={project.projectKey}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={(event) => {
                  if (event.shiftKey) onToggle(project.projectKey);
                  else onSelect(selected && scopedKeys.length === 1 ? null : project.projectKey);
                }}
                onContextMenu={(event) => onProjectSettings(event, project)}
                className={cn(
                  "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm font-medium outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  selected
                    ? "bg-sidebar-row-selected text-sidebar-foreground"
                    : "text-sidebar-foreground opacity-65 hover:bg-sidebar-row-hover hover:opacity-100",
                )}
              >
                <ProjectFavicon project={project} className="size-4 shrink-0" />
                <span className="truncate">{project.displayName}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {projects.length > shown.length ? (
        <p className="px-2 pt-1 text-xs text-sidebar-muted-foreground">
          {projects.length - shown.length} more in All projects
        </p>
      ) : null}
    </section>
  );
}
