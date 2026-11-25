import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectCloneSnapshot, ScopedProjectRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "./server";
import { sourceControlEnvironment } from "./sourceControl";

/** pending means the clone stream has not loaded; treating it as absent would briefly enable Start. */
export type ProjectCloneState = ProjectCloneSnapshot | "pending" | null;

const EMPTY_CLONES: ReadonlyArray<ProjectCloneSnapshot> = [];
const EMPTY_CLONE_ATOM = Atom.make<ProjectCloneState>(null).pipe(
  Atom.withLabel("mobile-project-clone:empty"),
);

const environmentProjectClonesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> | "pending" => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (!config) return EMPTY_CLONES;
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    // On subscription failure, let server dispatch guards decide rather than blocking Start until reconnect.
    if (result._tag === "Failure") return EMPTY_CLONES;
    return AsyncResult.getOrElse(result, () => "pending" as const);
  }).pipe(Atom.withLabel(`mobile-project-clones:${environmentId}`)),
);

export const environmentProjectCloneListAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> => {
    const clones = get(environmentProjectClonesAtom(environmentId));
    return clones === "pending" ? EMPTY_CLONES : clones;
  }).pipe(Atom.withLabel(`mobile-project-clone-list:${environmentId}`)),
);

const projectCloneAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ProjectCloneState => {
    if (ref === null) return null;
    const clones = get(environmentProjectClonesAtom(ref.environmentId));
    if (clones === "pending") return "pending";
    return clones.find((clone) => clone.projectId === ref.projectId) ?? null;
  }).pipe(Atom.withLabel(`mobile-project-clone:${key}`));
});

export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneState {
  return useAtomValue(ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(scopedProjectKey(ref)));
}

const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];

/** Keyed by the repository key, then the environment ids, one per line. */
const environmentsCloningRepositoryAtom = Atom.family((key: string) => {
  const [repositoryKey, ...environmentIds] = key.split("\n") as [string, ...EnvironmentId[]];
  return Atom.make((get): ReadonlyArray<EnvironmentId> =>
    environmentIds.filter((environmentId) =>
      get(environmentProjectCloneListAtom(environmentId)).some(
        (clone) =>
          (clone.phase === "running" || clone.phase === "done") &&
          sourceControlClients.repositoryKeyFromRemote(clone.remoteUrl) === repositoryKey,
      ),
    ),
  ).pipe(Atom.withLabel(`mobile-environments-cloning:${key}`));
});
const EMPTY_ENVIRONMENTS_ATOM = Atom.make(NO_ENVIRONMENTS).pipe(
  Atom.withLabel("mobile-environments-cloning:empty"),
);

/** Includes completed clones while the shell catches up with repository identity. */
export function useEnvironmentsCloningRemote(
  environmentIds: ReadonlyArray<EnvironmentId>,
  remoteUrl: string | null,
): ReadonlySet<EnvironmentId> {
  const repositoryKey = remoteUrl ? sourceControlClients.repositoryKeyFromRemote(remoteUrl) : null;
  const environments = useAtomValue(
    repositoryKey && environmentIds.length > 0
      ? environmentsCloningRepositoryAtom([repositoryKey, ...environmentIds].join("\n"))
      : EMPTY_ENVIRONMENTS_ATOM,
  );
  return new Set(environments);
}
