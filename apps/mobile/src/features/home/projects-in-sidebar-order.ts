import { useAtomValue } from "@effect/atom-react";
import { sortProjectsByGroupOrder } from "@t3tools/client-runtime/state/project-grouping";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { buildHomeProjectScopes, sortHomeProjectScopes } from "./homeThreadList";

type ProjectOrder = readonly {
  readonly memberProjectRefs: readonly ScopedProjectRef[];
  readonly pinned: boolean;
  readonly archived: boolean;
}[];
const sameProjectOrder = (previous: ProjectOrder, next: ProjectOrder) =>
  previous.length === next.length &&
  previous.every((group, index) => {
    const members = next[index]!.memberProjectRefs;
    return (
      group.pinned === next[index]!.pinned &&
      group.archived === next[index]!.archived &&
      group.memberProjectRefs.length === members.length &&
      group.memberProjectRefs.every(
        (ref, member) =>
          ref.environmentId === members[member]!.environmentId &&
          ref.projectId === members[member]!.projectId,
      )
    );
  });

// Thread shells change on every agent tick, but the sidebar order they decide rarely does. The
// equality check keeps screens that list projects from re-rendering on each tick.
const sidebarProjectOrderFamily = Atom.family((mode: SidebarProjectGroupingMode) =>
  Atom.make((get) =>
    sortHomeProjectScopes({
      scopes: buildHomeProjectScopes({
        projects: get(environmentProjects.projectsAtom),
        environmentId: null,
        projectGroupingMode: mode,
      }),
      threads: get(environmentThreadShells.threadShellsAtom),
      pendingTasks: [],
      projectSortOrder: "updated_at",
    }).map((scope) => ({
      memberProjectRefs: scope.projectRefs,
      pinned: scope.pinned,
      archived: scope.archived,
    })),
  ).pipe(Atom.withEquality(sameProjectOrder)),
);

export function useProjectsInSidebarOrder<Project extends { id: string; environmentId: string }>(
  projects: readonly Project[],
) {
  const { sidebarProjectGroupingMode } = useMobileProjectGroupingSettings();
  const scopes = useAtomValue(sidebarProjectOrderFamily(sidebarProjectGroupingMode));
  return sortProjectsByGroupOrder(projects, scopes);
}
