import type { EnvironmentId, GitButlerWorkspaceStatus, VcsStatusResult } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Skeleton } from "~/components/ui/skeleton";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useEnvironmentQuery, type EnvironmentQueryView } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";

import { GitButlerPanelContent, StateMessage } from "./GitButlerPanelContent";
import { useGitButlerRepositoryStatusRefresh } from "./useGitButlerRepositoryStatusRefresh";

export { GitButlerPanelContent, GitButlerUnavailableState } from "./GitButlerPanelContent";

export function GitButlerPanelView({
  query,
  onOpenReview,
  onOpenFile,
}: {
  readonly query: EnvironmentQueryView<GitButlerWorkspaceStatus>;
  readonly onOpenReview?: ((reviewNumber: number) => void) | undefined;
  readonly onOpenFile?: ((filePath: string) => void) | undefined;
}) {
  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-medium">GitButler workspace</h2>
          {query.data?.status === "ready" ? (
            <p className="text-[10px] text-muted-foreground" aria-live="polite">
              {query.error
                ? "Refresh failed · Showing cached data · "
                : query.isPending
                  ? "Refreshing · "
                  : ""}
              CLI {query.data.version}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh GitButler workspace"
          onClick={query.refresh}
          disabled={query.isPending}
        >
          <RefreshIcon className="size-3.5" refreshing={query.isPending} />
        </Button>
      </div>
      {query.error && query.data ? (
        <p className="border-b border-warning/30 bg-warning/8 px-3 py-2 text-[10px] text-warning-foreground">
          Refresh failed. Showing the last available workspace state.
        </p>
      ) : null}
      {query.data ? (
        <GitButlerPanelContent
          status={query.data}
          onOpenReview={onOpenReview}
          onOpenFile={onOpenFile}
        />
      ) : query.error ? (
        <StateMessage title="GitButler request failed" detail={query.error} tone="warning" />
      ) : (
        <div className="space-y-3 p-4" aria-label="Loading GitButler workspace">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}
    </div>
  );
}

export function GitButlerPanel({
  environmentId,
  cwd,
  repositoryStatus,
  workspaceMutationId,
  onOpenReview,
  onOpenFile,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly repositoryStatus: VcsStatusResult | null;
  readonly workspaceMutationId: string | null;
  readonly onOpenReview?: ((reviewNumber: number) => void) | undefined;
  readonly onOpenFile?: ((filePath: string) => void) | undefined;
}) {
  const query = useEnvironmentQuery(
    sourceControlEnvironment.gitButlerWorkspace({ environmentId, input: { cwd } }),
  );
  useGitButlerRepositoryStatusRefresh({ repositoryStatus, refresh: query.refresh });
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: query.refresh,
    resourceKey: `gitbutler:${environmentId}:${cwd}`,
  });

  return <GitButlerPanelView query={query} onOpenReview={onOpenReview} onOpenFile={onOpenFile} />;
}
