import {
  createIssueEnvironmentAtoms,
  createMergedIssueCandidatesAtoms,
  createMergedIssueListAtoms,
  type IssueCandidatesTarget,
  type IssueListTarget,
  type MergedIssueList,
} from "@t3tools/client-runtime/state/issues";
import { useAtomValue } from "@effect/atom-react";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueState, ThreadIssueLink } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";

export type { IssueListTarget };

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const linkedIssueRef = ({ projectId, tracker, host, scope, key }: ThreadIssueLink) => ({
  projectId,
  tracker,
  host,
  scope,
  key,
});

export function useLinkedIssueDetail(
  environmentId: EnvironmentId,
  link: ThreadIssueLink | undefined,
  mountScope?: "sidebar" | "thread-details" | "linked-items" | "sidebar-tooltip",
) {
  const configs = useServerConfigs();
  return useEnvironmentQuery(
    link && configs.get(environmentId)?.environment.capabilities.issues === true
      ? issueEnvironment.detail({ environmentId, input: linkedIssueRef(link) }, mountScope)
      : null,
  ).data;
}

const emptySidebarIssueState = Atom.make<IssueState | null>(null);

export function useSidebarLinkedIssueState(
  environmentId: EnvironmentId,
  links: ReadonlyArray<ThreadIssueLink> | undefined,
) {
  const configs = useServerConfigs();
  const aggregate =
    links?.length && configs.get(environmentId)?.environment.capabilities.issues === true
      ? Atom.make((get): IssueState | null => {
          // One detail read at a time, in link order: the first open issue decides the badge, so a
          // row with many links does not fetch every issue at once.
          const closed: Array<IssueState> = [];
          let unknown = false;
          for (const link of links) {
            const result = get(
              issueEnvironment.detail({ environmentId, input: linkedIssueRef(link) }, "sidebar"),
            );
            const state = selectEnvironmentQueryData(result)?.state;
            if (state?.category === "open") return state;
            if (state !== undefined) closed.push(state);
            else if (AsyncResult.isFailure(result)) unknown = true;
            else return null;
          }
          if (unknown) return null;
          return (
            closed.find((state) => state.closeReason && state.closeReason !== "completed") ??
            closed[0] ??
            null
          );
        })
      : emptySidebarIssueState;
  return useAtomValue(aggregate);
}

const mergedIssueLists = createMergedIssueListAtoms(issueEnvironment, formatEnvironmentQueryError);

/** The same listing read across every connected environment, as the pull-request page does. */
export function useIssueList(targets: ReadonlyArray<IssueListTarget>): MergedIssueList & {
  readonly refresh: () => void;
  readonly reload: () => void;
  readonly retry: () => void;
} {
  const view = useAtomValue(mergedIssueLists.atom(targets));
  return {
    ...view,
    refresh: () => mergedIssueLists.refresh(appAtomRegistry, targets, "manual"),
    reload: () => mergedIssueLists.refresh(appAtomRegistry, targets, "background"),
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
