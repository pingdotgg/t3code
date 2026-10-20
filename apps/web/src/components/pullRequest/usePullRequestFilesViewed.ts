import { useReviewFileProgress } from "@t3tools/client-runtime/review-file-progress";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
export type { PullRequestFilesViewedView } from "@t3tools/client-runtime/review-file-progress";

export function usePullRequestFilesViewed({
  environmentId,
  reference,
  enabled,
  paths,
  headSha,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly enabled: boolean;
  readonly paths: ReadonlyArray<string>;
  readonly headSha?: string | null | undefined;
}) {
  const query = useEnvironmentQuery(
    enabled ? pullRequestEnvironment.filesViewed({ environmentId, input: reference }) : null,
  );
  const write = useAtomCommand(pullRequestEnvironment.setFilesViewed, { reportFailure: false });
  const save = (files: ReadonlyArray<{ path: string; viewed: boolean }>) =>
    write({ environmentId, input: { ...reference, files } });
  const onError = () => {
    toastManager.add({ type: "error", title: "Could not update viewed files" });
  };
  return useReviewFileProgress({
    scopeKey: `${environmentId} ${reference.projectId} ${reference.host ?? ""} ${reference.repository} ${reference.number}`,
    enabled,
    paths,
    headSha,
    query,
    save,
    onError,
  });
}
