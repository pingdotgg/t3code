import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectCloneSnapshot, ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { serverEnvironment } from "./server";
import { sourceControlEnvironment } from "./sourceControl";

/**
 * `"pending"` while the environment's clone stream has not delivered its
 * first list yet: the draft opens right after a clone starts, and a caller
 * that treated the gap as "no clone" would enable Start for a moment.
 */
export type ProjectCloneState = ProjectCloneSnapshot | "pending" | null;

const EMPTY_CLONES: ReadonlyArray<ProjectCloneSnapshot> = [];
const EMPTY_CLONE_ATOM = Atom.make<ProjectCloneState>(null).pipe(
  Atom.withLabel("mobile-project-clone:empty"),
);

/**
 * Latest clone list an environment has streamed, `"pending"` until the first
 * one, and never subscribed on servers that predate clone tracking.
 */
const environmentProjectClonesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> | "pending" => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.projectCloneTracking !== true) return EMPTY_CLONES;
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    // A failed subscription must not hold Start forever. Treating it as
    // "no clone tracked" lets the server's own dispatch guard decide; the
    // registry re-establishes the stream on reconnect.
    if (result._tag === "Failure") return EMPTY_CLONES;
    return Option.getOrElse(AsyncResult.value(result), () => "pending" as const);
  }).pipe(Atom.withLabel(`mobile-project-clones:${environmentId}`)),
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

/**
 * The tracked clone for a project: `"pending"` before the stream's first
 * list, null once it finished or never started.
 */
export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneState {
  return useAtomValue(ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(scopedProjectKey(ref)));
}
