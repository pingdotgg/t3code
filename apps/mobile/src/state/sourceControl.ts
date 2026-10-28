import { useAtomValue } from "@effect/atom-react";
import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/source-control";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);

export function useSourceControlAccounts(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
) {
  return useAtomValue(
    sourceControlEnvironment.accounts(projects.map((project) => project.environmentId)),
  );
}
