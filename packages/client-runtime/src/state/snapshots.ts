import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  PiExternalCatalogSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentShellState } from "./shell.ts";
import type { PiExternalCatalogState } from "./piNative.ts";

export function mergeExternalCatalogShells(
  internal: OrchestrationShellSnapshot | null,
  external: PiExternalCatalogSnapshot | null,
): OrchestrationShellSnapshot | null {
  if (external === null) return internal;
  const base: OrchestrationShellSnapshot = internal ?? {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: external.updatedAt,
  };
  const internalThreadIds = new Set(base.threads.map((thread) => thread.id));
  // The catalog only carries sessions the server already associated with an
  // added project, but the internal snapshot can lag a project deletion, so
  // threads without a project here are dropped rather than rendered orphaned.
  const projectIds = new Set(base.projects.map((project) => project.id));
  const externalThreads = external.threads.filter(
    (thread) => !internalThreadIds.has(thread.id) && projectIds.has(thread.projectId),
  );
  return {
    ...base,
    threads: [...base.threads, ...externalThreads],
    externalOmittedThreadCount: external.omittedThreadCount,
    updatedAt:
      base.updatedAt.localeCompare(external.updatedAt) >= 0 ? base.updatedAt : external.updatedAt,
  };
}

export function createEnvironmentSnapshotAtom<E>(
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
  externalCatalogStateAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<PiExternalCatalogState, E>>,
) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): OrchestrationShellSnapshot | null => {
      const internal = Option.match(AsyncResult.value(get(shellStateAtom(environmentId))), {
        onNone: () => null,
        onSome: (state) => Option.getOrNull(state.snapshot),
      });
      const external =
        externalCatalogStateAtom === undefined
          ? null
          : Option.match(AsyncResult.value(get(externalCatalogStateAtom(environmentId))), {
              onNone: () => null,
              onSome: (state) => state.snapshot,
            });
      return mergeExternalCatalogShells(internal, external);
    }).pipe(Atom.withLabel(`environment-snapshot:${environmentId}`)),
  );
}
