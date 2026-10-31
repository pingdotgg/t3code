import { threadIdentifiersFromActivity } from "@t3tools/client-runtime/linear/activity";
import { createLinearEnvironmentAtoms } from "@t3tools/client-runtime/state/linear";
import type { LinearSearch } from "@t3tools/client-runtime/linear/search";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { linearThreadKey, resolveLinearEnvironmentId } from "../features/linear/linearEnvironment";
import { workspaceConnections } from "./workspace";

export const linearEnvironment = createLinearEnvironmentAtoms(connectionAtomRuntime);

/** The person's pick among connected environments, for this session only. */
export const linearSelectedEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.withLabel("mobile:linear-selected-environment"),
);

export const linearEnvironmentIdAtom = Atom.make((get) =>
  resolveLinearEnvironmentId(
    get(workspaceConnections.environmentsAtom),
    get(linearSelectedEnvironmentIdAtom),
  ),
).pipe(Atom.withLabel("mobile:linear-environment-id"));

/**
 * Issue-list filters (assignee, state, view, group, ...), kept for the session and across the
 * drill-down like the pull request tab's controls. The scope itself comes from the route.
 */
export const linearFiltersAtom = Atom.make<LinearSearch>({}).pipe(
  Atom.withLabel("mobile:linear-filters"),
);

/** The Linear environment's connection status; null until loaded or without one. */
export const linearStatusAtom = Atom.make((get) => {
  const environmentId = get(linearEnvironmentIdAtom);
  if (environmentId === null) return null;
  return AsyncResult.getOrElse(
    get(linearEnvironment.status({ environmentId, input: {} })),
    () => null,
  );
}).pipe(Atom.withLabel("mobile:linear-status"));

const NO_THREAD_IDENTIFIERS: ReadonlyMap<string, string> = new Map();

/**
 * Thread -> Linear issue identifier for the thread list. One shared derivation so list rows do
 * not each read the activity query; empty while Linear is not connected. It never polls: only
 * the focused Linear screen re-reads activity.
 */
const linearThreadIdentifiersAtom = Atom.make((get) => {
  const environmentId = get(linearEnvironmentIdAtom);
  if (environmentId === null) return NO_THREAD_IDENTIFIERS;
  const status = get(linearStatusAtom);
  if (status?.state !== "connected") return NO_THREAD_IDENTIFIERS;
  const activity = AsyncResult.getOrElse(
    get(linearEnvironment.activity({ environmentId, input: {} })),
    () => null,
  );
  if (activity === null || activity.issues.length === 0) return NO_THREAD_IDENTIFIERS;
  const identifiers = new Map<string, string>();
  for (const [threadId, identifier] of threadIdentifiersFromActivity(activity.issues)) {
    identifiers.set(linearThreadKey(environmentId, threadId), identifier);
  }
  return identifiers;
}).pipe(Atom.withLabel("mobile:linear-thread-identifiers"));

/** A row subscribes to its own identifier, so one change re-renders only the rows it touches. */
export const linearThreadIdentifierFamily = Atom.family((key: string) =>
  Atom.make((get) => get(linearThreadIdentifiersAtom).get(key) ?? null).pipe(
    Atom.withLabel("mobile:linear-thread-identifier"),
  ),
);
