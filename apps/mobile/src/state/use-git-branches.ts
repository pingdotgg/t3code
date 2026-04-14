import { useAtomValue } from "@effect/atom-react";
import {
  type GitBranchState,
  type GitBranchTarget,
  EMPTY_GIT_BRANCH_ATOM,
  EMPTY_GIT_BRANCH_STATE,
  createGitBranchManager,
  getGitBranchTargetKey,
  gitBranchStateAtom,
} from "@t3tools/client-runtime";

import { appAtomRegistry } from "./atom-registry";
import { getEnvironmentClient } from "./use-remote-environment-registry";

export const gitBranchManager = createGitBranchManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.git : null;
  },
});

export function useGitBranches(target: GitBranchTarget): GitBranchState {
  const targetKey = getGitBranchTargetKey(target);
  const state = useAtomValue(
    targetKey !== null ? gitBranchStateAtom(targetKey) : EMPTY_GIT_BRANCH_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_BRANCH_STATE : state;
}
