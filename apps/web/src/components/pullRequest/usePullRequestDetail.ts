import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestRef,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { usePullRequestChecksRefresh } from "~/hooks/usePullRequestChecksRefresh";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  newestPullRequestSummary,
  pullRequestEnvironment,
  pullRequestListEntryToSummary,
  useSharedPullRequestSummary,
} from "~/state/pullRequests";
import {
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
  resolvePullRequestDetailChecks,
  writePullRequestDetailSnapshot,
} from "./pullRequestDetail.logic";
import { pullRequestChecksState } from "./pullRequestPresentation";

export function pullRequestRefKey(reference: PullRequestRef) {
  return `${reference.projectId}:${reference.host ?? ""}:${reference.repository}#${reference.number}`;
}

function pullRequestDetailSummary(data: PullRequestDetail | null) {
  return data === null ? null : { ...data, checksState: pullRequestChecksState(data.checks) };
}

/**
 * Loads a pull request's detail and activity and merges them, with the snapshot cache, the shared
 * summary and the list row, into the detail the panel shows.
 */
export function usePullRequestDetail(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  listEntry: PullRequestListEntry | null,
) {
  const scopeKey = `${environmentId}:${pullRequestRefKey(reference)}`;
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  const serverConfigs = useServerConfigs();
  const supportsChecks =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequestChecks === true;
  const checksQuery = useEnvironmentQuery(
    supportsChecks && detailQuery.data !== null
      ? pullRequestEnvironment.checks({ environmentId, input: reference })
      : null,
  );
  const liveDetail = resolvePullRequestDetailChecks(
    detailQuery.data,
    checksQuery.data,
    checksQuery.dataUpdatedAt >= detailQuery.dataUpdatedAt,
  );
  usePullRequestChecksRefresh({
    refresh: () => {
      if (!checksQuery.isPending && !detailQuery.isPending) checksQuery.refresh();
    },
    enabled:
      liveDetail?.state === "open" &&
      supportsChecks &&
      !(checksQuery.isSuccess && checksQuery.data === null),
    key: `workspace-pr-checks:${environmentId}:${reference.projectId}:${reference.host}:${reference.repository}:${reference.number}`,
    checks: liveDetail?.checks ?? [],
  });
  const [cachedDetail, setCachedDetail] = useState(() =>
    readPullRequestDetailSnapshot(
      typeof window === "undefined" ? undefined : window.localStorage,
      environmentId,
      reference,
    ),
  );
  const [cachedDetailKey, setCachedDetailKey] = useState(scopeKey);
  if (cachedDetailKey !== scopeKey) {
    setCachedDetailKey(scopeKey);
    setCachedDetail(
      detailQuery.data ??
        readPullRequestDetailSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentId,
          reference,
        ),
    );
  } else if (detailQuery.data !== null && detailQuery.data !== cachedDetail) {
    setCachedDetail(detailQuery.data);
  }
  const saveDetailSnapshot = useEffectEvent((data: PullRequestDetail) => {
    writePullRequestDetailSnapshot(
      typeof window === "undefined" ? undefined : window.localStorage,
      environmentId,
      reference,
      data,
    );
  });
  useEffect(() => {
    if (detailQuery.data !== null) saveDetailSnapshot(detailQuery.data);
  }, [detailQuery.data]);
  const detailSummary = pullRequestDetailSummary(liveDetail);
  const observedSummary = useSharedPullRequestSummary(
    environmentId,
    reference,
    detailSummary,
    Math.max(detailQuery.dataUpdatedAt, checksQuery.dataUpdatedAt),
  );
  const activity = activityQuery.data;
  const resolvedCoreDetail = resolveDisplayedPullRequestDetail({
    live: liveDetail,
    cached: cachedDetail,
    reference,
  });
  // Every hook runs above this line: a hook between the merge and the panel's plain readers of
  // `detail` would cost it its cache scope.
  const listSummary = listEntry === null ? null : pullRequestListEntryToSummary(listEntry);
  // The list row is also published to the shared cache, but only after this commit's layout
  // effects run, so it is compared directly rather than trusted to be there already.
  const sharedSummary = newestPullRequestSummary(
    resolvedCoreDetail,
    newestPullRequestSummary(observedSummary, listSummary),
  );
  const coreDetail =
    resolvedCoreDetail === null || sharedSummary === null || sharedSummary === resolvedCoreDetail
      ? resolvedCoreDetail
      : {
          ...resolvedCoreDetail,
          title: sharedSummary.title,
          state: sharedSummary.state,
          headBranch: sharedSummary.headBranch,
          baseBranch: sharedSummary.baseBranch,
          updatedAt: sharedSummary.updatedAt,
          author: sharedSummary.author ?? resolvedCoreDetail.author,
          additions: sharedSummary.additions ?? resolvedCoreDetail.additions,
          deletions: sharedSummary.deletions ?? resolvedCoreDetail.deletions,
          changedFiles: sharedSummary.changedFiles ?? resolvedCoreDetail.changedFiles,
          mergeability: sharedSummary.mergeability ?? resolvedCoreDetail.mergeability,
          closedAt:
            sharedSummary.closedAt === undefined
              ? resolvedCoreDetail.closedAt
              : sharedSummary.closedAt,
          mergedAt:
            sharedSummary.mergedAt === undefined
              ? resolvedCoreDetail.mergedAt
              : sharedSummary.mergedAt,
          isDraft: sharedSummary.isDraft ?? resolvedCoreDetail.isDraft,
        };
  const detail =
    coreDetail === null
      ? null
      : {
          ...coreDetail,
          capabilities: canWriteSourceControl
            ? coreDetail.capabilities
            : {
                ...coreDetail.capabilities,
                reactions: false,
                edit: { changeRequest: false, comment: false },
              },
          viewerPermissions: canWriteSourceControl
            ? coreDetail.viewerPermissions
            : {
                ...coreDetail.viewerPermissions,
                actions: [],
                comment: false,
                resolve: false,
                verdicts: [],
                requestReviewers: false,
                updateMethods: [],
                labels: false,
              },
          author: activity?.author ?? coreDetail.author,
          reviewers: activity?.reviewers ?? coreDetail.reviewers,
          comments: activity?.comments ?? [],
          commentCount: Math.max(
            activity?.commentCount ?? 0,
            new Set([
              ...(activity?.comments.map((comment) => comment.id) ?? []),
              ...(activity?.reviewThreads.flatMap((thread) =>
                thread.comments.map((comment) => comment.id),
              ) ?? []),
            ]).size,
          ),
          commentsTruncated: activity?.commentsTruncated ?? false,
          reviewThreads: activity?.reviewThreads ?? [],
          commits: activity?.commits ?? [],
          reactions: activity?.reactions ?? [],
        };
  return {
    canWriteSourceControl,
    detailQuery,
    activityQuery,
    activity,
    sharedSummary,
    coreDetail,
    detail,
  };
}
