import type { EnvironmentId } from "@t3tools/contracts";
import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
} from "@t3tools/client-runtime/state/vcs";
import { resolveVcsTerminology, type VcsTerminology } from "@t3tools/shared/vcs";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);

/** Reads the shared status atom for (environment, cwd); Git terms until it answers. */
export function useVcsTerminology(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): VcsTerminology {
  const status = useEnvironmentQuery(
    environmentId === null || cwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  return resolveVcsTerminology(status.data);
}
