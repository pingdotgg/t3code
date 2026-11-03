import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells, olderSettledThreads } from "./threads";

/**
 * Whether a project has any thread, loaded or only counted as older settled.
 * A per-project boolean, so readers re-render when it flips, not on every
 * thread-shell change (which is frequent while agents work).
 */
export function makeProjectHasThreadsAtom(sources: {
  readonly threadRefsByProject: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyMap<ProjectId, ReadonlyArray<unknown>>>;
  readonly olderSettled: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<{ readonly counts: ReadonlyMap<ProjectId, number> } | null>;
}) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.family((projectId: ProjectId) =>
      Atom.make(
        (get) =>
          (get(sources.olderSettled(environmentId))?.counts.get(projectId) ?? 0) > 0 ||
          (get(sources.threadRefsByProject(environmentId)).get(projectId)?.length ?? 0) > 0,
      ).pipe(Atom.withLabel(`mobile:project-has-threads:${environmentId}:${projectId}`)),
    ),
  );
}

const projectHasThreadsAtom = makeProjectHasThreadsAtom({
  threadRefsByProject: environmentThreadShells.environmentThreadRefsByProjectAtom,
  olderSettled: olderSettledThreads.olderSettledAtom,
});

const NO_PROJECT_HAS_THREADS = Atom.make(false).pipe(
  Atom.withLabel("mobile:project-has-threads:none"),
);

export function useProjectHasThreads(
  project: { readonly environmentId: EnvironmentId; readonly id: ProjectId } | null,
): boolean {
  return useAtomValue(
    project === null
      ? NO_PROJECT_HAS_THREADS
      : projectHasThreadsAtom(project.environmentId)(project.id),
  );
}
