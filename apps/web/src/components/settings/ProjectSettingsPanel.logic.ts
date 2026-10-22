import type { Project } from "../../types";

/**
 * A rename must reach every member that lacks it, including members whose
 * folder-default title already matches, so the server records the choice.
 */
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
