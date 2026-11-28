import {
  createIssueEnvironmentAtoms,
  createMergedIssueCandidatesAtoms,
  createMergedIssueListAtoms,
  type IssueCandidatesTarget,
  type IssueListTarget,
} from "@t3tools/client-runtime/state/issues";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const mergedIssueLists = createMergedIssueListAtoms(issueEnvironment, formatEnvironmentQueryError);

/** One listing read across every environment asked. */
export function useIssueList(targets: ReadonlyArray<IssueListTarget>) {
  const view = useAtomValue(mergedIssueLists.atom(targets));
  return {
    ...view,
    refresh: () => mergedIssueLists.refresh(appAtomRegistry, targets, "manual"),
  };
}

/** After a write the list cannot see, such as a new issue filed from a sheet. */
export function refreshIssueLists(environmentId: EnvironmentId) {
  mergedIssueLists.refreshEnvironment(appAtomRegistry, environmentId);
}

const mergedIssueCandidates = createMergedIssueCandidatesAtoms(
  issueEnvironment.candidates,
  formatEnvironmentQueryError,
);

/** The labels and people of every scope a list filter covers; no targets reads nothing. */
export function useIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  return useAtomValue(mergedIssueCandidates.atom(targets));
}

/** Asks again only the scopes that failed; the ones that answered keep their answer. */
export function refreshIssueFilterCandidates(targets: ReadonlyArray<IssueCandidatesTarget>) {
  mergedIssueCandidates.retry(appAtomRegistry, targets);
}
