import type { ProjectIconOverride } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { Project } from "../../types";

export const SCRATCH_PROJECT_TITLE = "No project";
const SCRATCH_PROJECT_ICON = {
  kind: "lucide",
  name: "message-square-dashed",
  color: "gray",
} as const satisfies ProjectIconOverride;

export function scopeProjectSettingsGroup(
  group: SidebarProjectSnapshot,
  members: readonly SidebarProjectGroupMember[],
): SidebarProjectSnapshot {
  const representative =
    members.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? members[0]!;
  return { ...group, ...representative, memberProjects: members };
}

export function projectGroupTitleNeedsUpdate(
  members: ReadonlyArray<Pick<Project, "title" | "hasCustomTitle">>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return (
    wasEdited &&
    members.some((member) => member.title !== nextTitle || member.hasCustomTitle !== true)
  );
}

export function defaultProjectIcon(project: Pick<Project, "isScratch">) {
  return { faviconPath: null, projectIcon: project.isScratch ? SCRATCH_PROJECT_ICON : null };
}

export function hasDefaultProjectIcon(
  project: Pick<Project, "isScratch" | "faviconPath" | "projectIcon">,
): boolean {
  if (project.faviconPath != null) return false;
  const icon = project.projectIcon ?? null;
  if (!project.isScratch) return icon === null;
  return (
    icon?.kind === "lucide" &&
    icon.name === SCRATCH_PROJECT_ICON.name &&
    icon.color === SCRATCH_PROJECT_ICON.color
  );
}
