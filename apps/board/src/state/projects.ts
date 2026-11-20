import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentProjectAtoms,
  createProjectEnvironmentAtoms,
} from "@t3tools/client-runtime/state/projects";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
} from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});

/** The one engine the app talks to, which has no id until it answers. */
export const engineEnvironmentIdAtom = Atom.make(
  (get) =>
    get(environmentCatalog.catalogValueAtom).entries.values().next().value?.target.environmentId ??
    null,
).pipe(Atom.withLabel("engine-environment-id"));

export interface ThreadCount {
  readonly total: number;
  /** Threads whose latest run has not finished. */
  readonly active: number;
}

const WORKING: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const NO_THREAD_COUNTS: ReadonlyMap<string, ThreadCount> = new Map();

/** Listed threads per project, which the sidebar shows as a count chip. */
export const threadCountsAtom = Atom.make((get): ReadonlyMap<string, ThreadCount> => {
  const environmentId = get(engineEnvironmentIdAtom);
  const threads =
    environmentId === null ? undefined : get(environmentSnapshotAtom(environmentId))?.threads;
  if (threads === undefined) return NO_THREAD_COUNTS;
  const counts = new Map<string, ThreadCount>();
  for (const thread of threads) {
    if (!isListedThreadLineage(thread.lineage)) continue;
    const before = counts.get(thread.projectId) ?? { total: 0, active: 0 };
    counts.set(thread.projectId, {
      total: before.total + 1,
      active: before.active + (WORKING.has(thread.status) ? 1 : 0),
    });
  }
  return counts;
}).pipe(Atom.withLabel("project-thread-counts"));

export interface EngineConnection {
  readonly state: SupervisorConnectionState;
  /** Set when the client refuses the engine, for example one that is too old. */
  readonly unsupportedReason: string | undefined;
}

const NOT_REGISTERED: EngineConnection = {
  state: AVAILABLE_CONNECTION_STATE,
  unsupportedReason: undefined,
};

/** The connection to the one engine the app talks to, which is not registered until it answers. */
export const engineConnectionAtom = Atom.make((get): EngineConnection => {
  const [entry] = get(environmentCatalog.catalogValueAtom).entries.values();
  if (entry === undefined) return NOT_REGISTERED;
  return {
    state: AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(entry.target.environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    ),
    unsupportedReason: entry.unsupportedReason,
  };
}).pipe(Atom.withLabel("engine-connection"));
