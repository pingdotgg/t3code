import {
  createIssueEnvironmentAtoms,
  createMergedIssueCandidatesAtoms,
  createMergedIssueListAtoms,
  type IssueCandidatesTarget,
  type IssueListTarget,
  type MergedIssueList,
} from "@t3tools/client-runtime/state/issues";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadIssueLink } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";

export type { IssueListTarget };

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export function useLinkedIssueDetail(
  environmentId: EnvironmentId,
  link: ThreadIssueLink | undefined,
  mountScope?: "sidebar" | "thread-details" | "linked-items" | "sidebar-tooltip",
) {
  const configs = useServerConfigs();
  const input = link && {
    projectId: link.projectId,
    tracker: link.tracker,
    host: link.host,
    scope: link.scope,
    key: link.key,
  };
  return useEnvironmentQuery(
    input && configs.get(environmentId)?.environment.capabilities.issues === true
      ? issueEnvironment.detail({ environmentId, input }, mountScope)
      : null,
  ).data;
}

const mergedIssueLists = createMergedIssueListAtoms(
  issueEnvironment.list,
  formatEnvironmentQueryError,
);

/** The same listing read across every connected environment, as the pull-request page does. */
export function useIssueList(
  targets: ReadonlyArray<IssueListTarget>,
): MergedIssueList & { readonly refresh: () => void; readonly retry: () => void } {
  const view = useAtomValue(mergedIssueLists.atom(targets));
  return {
    ...view,
    refresh: () => mergedIssueLists.refresh(appAtomRegistry, targets),
    retry: () => mergedIssueLists.retry(appAtomRegistry, targets),
  };
}

/** After a write made beside the list, such as a state change in the detail panel. */
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
