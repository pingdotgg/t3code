import { useAtomValue } from "@effect/atom-react";
import { useReviewFileProgress } from "@t3tools/client-runtime/review-file-progress";
import type { PullRequestDetail } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { pullRequestReviewKey } from "./pullRequestReviewDrafts";

export function usePullRequestFilesViewed(params: PullRequestParams, pr: PullRequestDetail | null) {
  const target = pullRequestTarget(params);
  const supported = Boolean(pr?.capabilities.viewedFiles);
  const permission = useAtomValue(
    composerPullRequests.setFilesViewed.permissionAtom(target.environmentId),
  );
  const connected = usePullRequestConnected(params.environmentId);
  const query = useEnvironmentQuery(supported ? composerPullRequests.filesViewed(target) : null);
  const write = useAtomCommand(composerPullRequests.setFilesViewed, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    (files: ReadonlyArray<{ path: string; viewed: boolean }>) =>
      write({
        environmentId: pullRequestTarget(params).environmentId,
        input: { ...pullRequestTarget(params).input, files },
      }),
    [params, write],
  );
  const onError = useCallback(() => setError("Could not update viewed files."), []);
  const progress = useReviewFileProgress({
    scopeKey: pullRequestReviewKey(params),
    enabled: supported,
    paths: query.data?.files.map((file) => file.path) ?? [],
    headSha: pr?.headSha,
    query,
    save,
    onError,
  });
  const filePaths = useMemo(
    () => (query.data && !query.data.truncated ? query.data.files.map((file) => file.path) : null),
    [query.data],
  );
  const canToggle = supported && connected && permission && Boolean(query.data);
  const setViewed = (path: string, viewed: boolean) => {
    if (!canToggle) return;
    setError(null);
    progress.setViewed(path, viewed);
  };
  const setManyViewed = (paths: ReadonlyArray<string>, viewed: boolean) => {
    for (const path of paths) setViewed(path, viewed);
  };
  return {
    ...progress,
    supported,
    filePaths,
    canToggle,
    error: error ?? query.error,
    setViewed,
    setManyViewed,
    toggle: (path: string) => setViewed(path, !progress.isViewed(path)),
  };
}
