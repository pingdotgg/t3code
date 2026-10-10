import type { EnvironmentId } from "@t3tools/contracts";

import { derivePhysicalProjectKeyFromPath } from "../../logicalProject";
import { legacyProjectCwdPreferenceKey } from "../../uiStateStore";

/** Old to new keys of the sidebar preferences stored under a checkout's folder. */
export function projectFolderKeyRenames(
  environmentId: EnvironmentId,
  from: string,
  to: string,
): ReadonlyMap<string, string> {
  return new Map([
    [
      derivePhysicalProjectKeyFromPath(environmentId, from),
      derivePhysicalProjectKeyFromPath(environmentId, to),
    ],
    [legacyProjectCwdPreferenceKey(from), legacyProjectCwdPreferenceKey(to)],
  ]);
}

export function projectGroupTitleNeedsUpdate(
  memberTitles: ReadonlyArray<string>,
  nextTitle: string,
  wasEdited: boolean,
): boolean {
  return wasEdited && memberTitles.some((title) => title !== nextTitle);
}
