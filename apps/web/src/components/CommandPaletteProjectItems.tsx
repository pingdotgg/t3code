import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import {
  buildCommandPaletteProjectMetadata,
  buildProjectActionItems,
  type CommandPaletteItemPin,
  type CommandPaletteProject,
  ITEM_ICON_CLASS,
} from "./CommandPalette.logic";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProjectFavicon } from "./ProjectFavicon";
import { COMMAND_PALETTE_META_ICON_CLASS } from "./ThreadCommandSubtitle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface CommandPaletteProjectLocation {
  readonly kind: "local" | "remote";
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

const UNKNOWN_PROJECT_LOCATION: CommandPaletteProjectLocation = {
  kind: "remote",
  label: "Remote",
  machine: "server",
};

interface ProjectItemsInput {
  readonly projects: ReadonlyArray<CommandPaletteProject>;
  readonly projectGroupByTargetKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly locationByEnvironmentId: ReadonlyMap<EnvironmentId, CommandPaletteProjectLocation>;
  readonly runProject: (project: CommandPaletteProject) => Promise<void>;
  readonly pin?: (project: CommandPaletteProject) => CommandPaletteItemPin | null;
}

function projectFaviconIcon(project: Project) {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

/** Projects as root search results; a grouped project matches on every member. */
export function buildProjectSearchItems(input: ProjectItemsInput) {
  const membersOf = (project: CommandPaletteProject) =>
    input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`)?.memberProjects ?? [
      project,
    ];
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "project",
    searchTerms: (project) =>
      buildCommandPaletteProjectMetadata({
        projects: membersOf(project),
        locationByEnvironmentId: input.locationByEnvironmentId,
      }).searchTerms,
    renderDescription: (project) => {
      const members = membersOf(project);
      const metadata = buildCommandPaletteProjectMetadata({
        projects: members,
        locationByEnvironmentId: input.locationByEnvironmentId,
      });
      return members.length > 1 ? (
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} />}>
            {metadata.environmentLabels.length} machines
          </TooltipTrigger>
          <TooltipPopup>
            {metadata.environmentLabels.map((label) => (
              <span className="block" key={label}>
                {label}
              </span>
            ))}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <ProjectLocationDescription
          location={input.locationByEnvironmentId.get(project.environmentId)}
          workspaceRoot={project.workspaceRoot}
        />
      );
    },
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
  });
}

/** Projects as targets of the "New thread in..." submenu. */
export function buildNewThreadInProjectItems(
  input: ProjectItemsInput & { readonly currentProjectKey: string | null },
) {
  return buildProjectActionItems({
    projects: input.projects,
    valuePrefix: "new-thread-in",
    searchTerms: (project) => {
      const group = input.projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const location = input.locationByEnvironmentId.get(project.environmentId);
      return [
        ...(group?.memberProjects.flatMap((member) => [member.title, member.workspaceRoot]) ?? []),
        ...(location ? [location.label] : []),
      ];
    },
    renderDescription: (project) => (
      <ProjectLocationDescription
        location={input.locationByEnvironmentId.get(project.environmentId)}
        workspaceRoot={project.workspaceRoot}
        current={input.currentProjectKey === `${project.environmentId}:${project.id}`}
      />
    ),
    icon: projectFaviconIcon,
    runProject: input.runProject,
    ...(input.pin ? { pin: input.pin } : {}),
  });
}

function ProjectLocationDescription(props: {
  readonly location: CommandPaletteProjectLocation | undefined;
  readonly workspaceRoot: string;
  readonly current?: boolean;
}) {
  const location = props.location ?? UNKNOWN_PROJECT_LOCATION;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {props.current ? <span className="shrink-0">Current</span> : null}
      <span className="inline-flex min-w-0 max-w-1/2 shrink-0 items-center gap-1">
        {location.kind === "remote" ? (
          <EnvironmentMachineIcon
            aria-hidden
            kind={location.machine}
            className={COMMAND_PALETTE_META_ICON_CLASS}
          />
        ) : null}
        <span className="truncate">{location.label}</span>
      </span>
      <span className="min-w-0 truncate">{props.workspaceRoot}</span>
    </span>
  );
}
