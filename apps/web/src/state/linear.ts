import { threadIdentifiersFromActivity } from "@t3tools/client-runtime/linear/activity";
import { createLinearEnvironmentAtoms } from "@t3tools/client-runtime/state/linear";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

/**
 * Linear query atoms and commands. Linear is served by the primary environment only; pass its
 * id (see `usePrimaryEnvironmentId`) as `environmentId`.
 */
export const linearEnvironment = createLinearEnvironmentAtoms(connectionAtomRuntime);

const NO_THREAD_IDENTIFIERS: ReadonlyMap<string, string> = new Map();

/** Connection status of the primary environment's Linear workspace; null until loaded. */
export const linearStatusAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  return AsyncResult.getOrElse(
    get(linearEnvironment.status({ environmentId, input: {} })),
    () => null,
  );
}).pipe(Atom.withLabel("web-linear-status"));

/**
 * Thread id -> Linear issue identifier ("ATT-615") for sidebar rows. One shared derivation so
 * thousands of rows do not each read the activity query; empty while Linear is not connected.
 * It never polls: only the open Linear page bumps the poll tick.
 */
export const linearThreadIdentifiersAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return NO_THREAD_IDENTIFIERS;
  const status = get(linearStatusAtom);
  if (status?.state !== "connected") return NO_THREAD_IDENTIFIERS;
  const activity = AsyncResult.getOrElse(
    get(linearEnvironment.activity({ environmentId, input: {} })),
    () => null,
  );
  if (activity === null || activity.issues.length === 0) return NO_THREAD_IDENTIFIERS;
  return threadIdentifiersFromActivity(activity.issues);
}).pipe(Atom.withLabel("web-linear-thread-identifiers"));
