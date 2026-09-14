import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectCloneSnapshot, ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentServerConfigsAtom } from "./server";
import { sourceControlEnvironment } from "./sourceControl";

const EMPTY_CLONES: ReadonlyArray<ProjectCloneSnapshot> = [];
const EMPTY_CLONE_ATOM = Atom.make<ProjectCloneSnapshot | null>(null).pipe(
  Atom.withLabel("web-project-clone:empty"),
);

/**
 * Latest clone list an environment has streamed; empty until the subscription
 * delivers, and never subscribed on servers that predate clone tracking.
 */
const environmentProjectClonesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> => {
    const supported =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .projectCloneTracking === true;
    if (!supported) return EMPTY_CLONES;
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY_CLONES);
  }).pipe(Atom.withLabel(`web-project-clones:${environmentId}`)),
);

const projectCloneAtom = Atom.family((key: string) => {
  const separator = key.indexOf(":");
  const environmentId = key.slice(0, separator) as EnvironmentId;
  const projectId = key.slice(separator + 1);
  return Atom.make((get): ProjectCloneSnapshot | null => {
    const clones = get(environmentProjectClonesAtom(environmentId));
    return clones.find((clone) => clone.projectId === projectId) ?? null;
  }).pipe(Atom.withLabel(`web-project-clone:${key}`));
});

/**
 * The tracked clone for a project, or null once it finished (or never
 * existed). Subscribing here opens the environment's clone stream, which is
 * cheap: the server sends an empty list and stays quiet until a clone starts.
 */
export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneSnapshot | null {
  return useAtomValue(
    ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(`${ref.environmentId}:${ref.projectId}`),
  );
}

export function useEnvironmentProjectClones(
  environmentId: EnvironmentId,
): ReadonlyArray<ProjectCloneSnapshot> {
  return useAtomValue(environmentProjectClonesAtom(environmentId));
}
