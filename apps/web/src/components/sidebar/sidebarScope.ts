import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";

export interface SidebarScope {
  /** Effective environment; null is every environment. A stored id that is not a current choice reads as null at once. */
  readonly environment: EnvironmentPresentation | null;
  /** Groups with a member on the effective environment; the input array itself when there is none. */
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  /** Effective project group, looked up in the narrowed `projectGroups`. */
  readonly projectGroup: SidebarProjectSnapshot | null;
  /** Effective axes only, for consumers that reset when the scope flips. */
  readonly key: string;
  /** Stored values proven absent. Never true before every enabled environment has a live project snapshot. */
  readonly stale: { readonly environment: boolean; readonly project: boolean };
}

/**
 * The two stored scope keys resolved against what the sidebar can currently
 * show. The project key is a logical group key that spans machines by design,
 * so the axes are independent in storage and narrow each other only here: the
 * group is looked up in the list already narrowed to the environment, so
 * "not on this environment" and "gone" are one rule. Absence is only marked
 * stale once `snapshotsReady`, because a cached or disconnected environment
 * cannot prove that anything is gone.
 */
export function resolveSidebarScope(input: {
  readonly environmentScopeId: EnvironmentId | null;
  readonly projectScopeKey: string | null;
  readonly environmentItems: readonly EnvironmentPresentation[];
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly snapshotsReady: boolean;
}): SidebarScope {
  const environment =
    input.environmentScopeId === null
      ? null
      : (input.environmentItems.find((item) => item.environmentId === input.environmentScopeId) ??
        null);
  const projectGroups =
    environment === null
      ? input.projectGroups
      : input.projectGroups.filter((group) =>
          group.memberProjectRefs.some(
            (projectRef) => projectRef.environmentId === environment.environmentId,
          ),
        );
  const projectGroup =
    input.projectScopeKey === null
      ? null
      : (projectGroups.find((group) => group.projectKey === input.projectScopeKey) ?? null);
  return {
    environment,
    projectGroups,
    projectGroup,
    key: `${environment?.environmentId ?? "all"}:${projectGroup?.projectKey ?? "all"}`,
    stale: {
      environment:
        input.environmentScopeId !== null && input.snapshotsReady && environment === null,
      project: input.projectScopeKey !== null && input.snapshotsReady && projectGroup === null,
    },
  };
}

/** Physical keys of the scoped group's members on every machine; null is every project. */
export function sidebarScopeProjectKeys(
  projectGroup: SidebarProjectSnapshot | null,
): ReadonlySet<string> | null {
  return projectGroup === null
    ? null
    : new Set(projectGroup.memberProjectRefs.map(scopedProjectKey));
}

/**
 * What the visibility test reads: a primitive and a set that only change when
 * the effective scope does, so hot memos keyed on them survive catalog churn.
 */
export interface SidebarScopeFilter {
  readonly environmentId: EnvironmentId | null;
  readonly projectKeys: ReadonlySet<string> | null;
}

/** The one visibility test threads, draft rows and the draft count share. */
export function sidebarScopeIncludes(filter: SidebarScopeFilter, ref: ScopedProjectRef): boolean {
  return (
    (filter.environmentId === null || ref.environmentId === filter.environmentId) &&
    (filter.projectKeys === null || filter.projectKeys.has(scopedProjectKey(ref)))
  );
}
