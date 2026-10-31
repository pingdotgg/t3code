import type { ProjectId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { LinearGlyph } from "./linearIcons";

/** Marks a project the Linear mapping chose, next to its name. */
export function FromMappingBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-px text-2xs font-medium text-primary">
      <LinearGlyph className="size-2.5" />
      from mapping
    </span>
  );
}

/** One of this environment's T3 projects. Shared by the mapping, launch and pipeline flows. */
export function LinearProjectSelect({
  projects,
  value,
  onValueChange,
  fromMapping = false,
  placeholder = "Choose a project",
  size = "sm",
  className,
  "aria-label": ariaLabel = "T3 project",
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: ProjectId | null;
  readonly onValueChange: (projectId: ProjectId) => void;
  readonly fromMapping?: boolean;
  readonly placeholder?: string;
  readonly size?: "sm" | "default";
  readonly className?: string;
  readonly "aria-label"?: string;
}) {
  const selected = projects.find((project) => project.id === value) ?? null;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const project = projects.find((candidate) => candidate.id === next);
        if (project) onValueChange(project.id);
      }}
    >
      <SelectTrigger size={size} aria-label={ariaLabel} className={cn("min-w-0", className)}>
        <span className="flex min-w-0 items-center gap-2">
          {selected ? <ProjectFavicon project={selected} className="size-4 shrink-0" /> : null}
          <SelectValue>
            {() => <span className="truncate">{selected ? selected.title : placeholder}</span>}
          </SelectValue>
          {fromMapping && selected ? <FromMappingBadge /> : null}
        </span>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <span className="flex items-center gap-2">
              <ProjectFavicon project={project} className="size-4 shrink-0" />
              {project.title}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
