import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectCloneSnapshot, ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentServerConfigsAtom } from "./server";
import { sourceControlEnvironment } from "./sourceControl";

const EMPTY_CLONES: ReadonlyArray<ProjectCloneSnapshot> = [];
const EMPTY_CLONE_ATOM = Atom.make<ProjectCloneSnapshot | null>(null).pipe(
  Atom.withLabel("web-project-clone:empty"),
);
const NOT_PENDING_ATOM = Atom.make(false).pipe(Atom.withLabel("web-project-clones-pending:none"));

/**
 * Latest clone list an environment has streamed; empty until the subscription
 * delivers, and never subscribed on servers that predate clone tracking.
 */
export const environmentProjectClonesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> => {
    const supported =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .projectCloneTracking === true;
    if (!supported) return EMPTY_CLONES;
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY_CLONES);
  }).pipe(Atom.withLabel(`web-project-clones:${environmentId}`)),
);

/**
 * True until a clone-tracking environment has streamed its clone list, so a
 * caller can tell "not cloning" from "not known yet". Servers without clone
 * tracking are never pending.
 */
const environmentProjectClonesPendingAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): boolean => {
    const config = get(environmentServerConfigsAtom).get(environmentId);
    if (config === undefined) return true;
    if (config.environment.capabilities.projectCloneTracking !== true) return false;
    // Pending until a list arrives: a stream that fails first never delivered one.
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    return Option.isNone(AsyncResult.value(result));
  }).pipe(Atom.withLabel(`web-project-clones-pending:${environmentId}`)),
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
 * The tracked clone for a project, or null when none is tracked. A finished
 * clone stays for a short while with phase "done". Subscribing here opens the
 * environment's clone stream, which is cheap: the server sends an empty list
 * and stays quiet until a clone starts.
 */
export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneSnapshot | null {
  return useAtomValue(ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(scopedProjectKey(ref)));
}

export function useEnvironmentProjectClones(
  environmentId: EnvironmentId,
): ReadonlyArray<ProjectCloneSnapshot> {
  return useAtomValue(environmentProjectClonesAtom(environmentId));
}

export function useEnvironmentProjectClonesPending(environmentId: EnvironmentId): boolean {
  return useAtomValue(environmentProjectClonesPendingAtom(environmentId));
}

/**
 * False while a project's git state cannot be trusted: before the environment's
 * clone list arrives, while the project clones, and while its finished clone is
 * still tracked (status lags the checkout by a few seconds).
 */
export function useIsProjectCloneSettled(ref: ScopedProjectRef | null): boolean {
  const clone = useProjectClone(ref);
  const pending = useAtomValue(
    ref === null ? NOT_PENDING_ATOM : environmentProjectClonesPendingAtom(ref.environmentId),
  );
  return !pending && clone === null;
}
