import {
  createIssueEnvironmentAtoms,
  createMergedIssueListAtoms,
  type IssueListTarget,
} from "@t3tools/client-runtime/state/issues";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const mergedIssueLists = createMergedIssueListAtoms(
  issueEnvironment.list,
  formatEnvironmentQueryError,
);

/** One listing read across every environment asked. */
export function useIssueList(targets: ReadonlyArray<IssueListTarget>) {
  const view = useAtomValue(mergedIssueLists.atom(targets));
  return { ...view, refresh: () => mergedIssueLists.refresh(appAtomRegistry, targets) };
}

/** After a write the list cannot see, such as a new issue filed from a sheet. */
export function refreshIssueLists(environmentId: EnvironmentId) {
  mergedIssueLists.refreshEnvironment(appAtomRegistry, environmentId);
}
