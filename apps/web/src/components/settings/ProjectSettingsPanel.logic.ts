import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}

export function projectSettingsRepresentative(
  group: SidebarProjectSnapshot,
  members = group.memberProjects,
) {
  return (
    members.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ?? members[0]!
  );
}
