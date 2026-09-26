import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type IssueRef, ISSUE_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { mergeIssueLists } from "../components/issues/issueList.logic";
import { createMergedEnvironmentQuery, type EnvironmentQueryTarget } from "./pullRequests";
import type { IssueListInput } from "@t3tools/contracts";

const issueList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:list",
  tag: ISSUE_WS_METHODS.issuesList,
  staleTimeMs: 30_000,
});

export const issueDetail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:detail",
  tag: ISSUE_WS_METHODS.issuesDetail,
  staleTimeMs: 15_000,
});

/** Reads the side panel again after the Issue changed. */
const refreshDetail = (
  target: { readonly environmentId: EnvironmentId; readonly input: IssueRef },
  registry: { refresh: (atom: ReturnType<typeof issueDetail>) => void },
) =>
  Effect.sync(() =>
    registry.refresh(
      issueDetail({
        environmentId: target.environmentId,
        input: {
          host: target.input.host,
          repository: target.input.repository,
          number: target.input.number,
        },
      }),
    ),
  );

export const issueComment = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:issues:comment",
  tag: ISSUE_WS_METHODS.issuesComment,
  onSuccess: refreshDetail,
});

export const issueSetState = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:issues:set-state",
  tag: ISSUE_WS_METHODS.issuesSetState,
  onSuccess: refreshDetail,
});

/** One Issue read on demand: a row's "Start thread" needs the body the list does not carry. */
export const issueDetailRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:issues:detail-read",
  tag: ISSUE_WS_METHODS.issuesDetail,
});

const useIssueListsQuery = createMergedEnvironmentQuery("web-issues:list", issueList);

/** One listing per environment, merged into the list the page renders. */
export function useIssueList(targets: ReadonlyArray<EnvironmentQueryTarget<IssueListInput>>) {
  const query = useIssueListsQuery(targets);
  const data = useMemo(() => mergeIssueLists(query.values), [query.values]);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}

export function useIssueDetail(environmentId: EnvironmentId, ref: IssueRef) {
  return useAtomValue(issueDetail({ environmentId, input: ref }));
}
