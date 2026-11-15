import {
  createIssueEnvironmentAtoms,
  createMergedIssueListAtoms,
  type IssueListTarget,
  type MergedIssueList,
} from "@t3tools/client-runtime/state/issues";
import { useAtomValue } from "@effect/atom-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./query";

export type { IssueListTarget };

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

const mergedIssueLists = createMergedIssueListAtoms(
  issueEnvironment.list,
  formatEnvironmentQueryError,
);

/** The same listing read across every connected environment, as the pull-request page does. */
export function useIssueList(
  targets: ReadonlyArray<IssueListTarget>,
): MergedIssueList & { readonly refresh: () => void } {
  const view = useAtomValue(mergedIssueLists.atom(targets));
  return { ...view, refresh: () => mergedIssueLists.refresh(appAtomRegistry, targets) };
}
