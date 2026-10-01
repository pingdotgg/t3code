import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
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
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ProjectCloneSnapshot | null => {
    if (ref === null) return null;
    const clones = get(environmentProjectClonesAtom(ref.environmentId));
    return clones.find((clone) => clone.projectId === ref.projectId) ?? null;
  }).pipe(Atom.withLabel(`web-project-clone:${key}`));
});

/**
 * The tracked clone for a project, or null once it finished (or never
 * existed). Subscribing here opens the environment's clone stream, which is
 * cheap: the server sends an empty list and stays quiet until a clone starts.
 */
export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneSnapshot | null {
  return useAtomValue(ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(scopedProjectKey(ref)));
}

export function useEnvironmentProjectClones(
  environmentId: EnvironmentId,
): ReadonlyArray<ProjectCloneSnapshot> {
  return useAtomValue(environmentProjectClonesAtom(environmentId));
}
