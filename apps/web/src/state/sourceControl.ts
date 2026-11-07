import { useAtomValue } from "@effect/atom-react";
import { createSourceControlEnvironmentAtoms } from "@t3tools/client-runtime/state/source-control";

import { connectionAtomRuntime } from "../connection/runtime";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);

export function useSourceControlAccounts(
  projects: Parameters<typeof sourceControlEnvironment.accounts>[0],
) {
  return useAtomValue(sourceControlEnvironment.accounts(projects));
}
