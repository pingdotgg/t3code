import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, RefreshCwIcon, UploadIcon } from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import {
  useSourceControlActionRunning,
  useVcsFetchAction,
  useVcsPullAction,
  useVcsPushAction,
  useVcsSyncAction,
} from "../lib/sourceControlActions";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface GitSyncControlProps {
  environmentId: EnvironmentId;
  cwd: string | null;
  /** Latest VCS status (reused from the branch selector — no extra subscription). */
  status: VcsStatusResult | null;
  className?: string;
}

// Kept in sync with the action kinds this control can launch so any one of them
// (including a concurrent stacked action) disables the whole control. Exported so
// the branch picker can disable ref switches while a sync op is in flight.
export const SYNC_BUSY_ACTIONS = ["runStackedAction", "pull", "fetch", "push", "sync"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

function isDivergedError(
  error: unknown,
): error is { _tag: "GitDivergedError"; refName: string; aheadCount: number; behindCount: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "GitDivergedError"
  );
}

/**
 * VS Code-style ahead/behind indicator + one-click sync, shown next to the
 * branch in the composer toolbar. States: publish (no upstream), pull (behind),
 * push (ahead), sync (both), or up-to-date. A standalone Fetch button forces an
 * immediate refresh of the ahead/behind counts.
 */
export function GitSyncControl({ environmentId, cwd, status, className }: GitSyncControlProps) {
  const scope = useMemo(() => ({ environmentId, cwd }), [environmentId, cwd]);
  const fetchAction = useVcsFetchAction(scope);
  const pullAction = useVcsPullAction(scope);
  const pushAction = useVcsPushAction(scope);
  const syncAction = useVcsSyncAction(scope);
  const isRunning = useSourceControlActionRunning(scope, SYNC_BUSY_ACTIONS);

  const onFetch = useCallback(() => {
    const promise = fetchAction.run();
    void toastManager.promise<Awaited<ReturnType<typeof fetchAction.run>>>(promise, {
      loading: { title: "Fetching..." },
      // vcs.fetch only updates remote-tracking refs; the branch may now be ahead
      // or behind, so don't claim "Up to date" here — the badge reflects the state.
      success: () => ({ title: "Fetched", description: "Updated remote-tracking refs." }),
      error: (err) => ({ title: "Fetch failed", description: errorMessage(err) }),
    });
    void promise.catch(() => undefined);
  }, [fetchAction]);

  const onPull = useCallback(() => {
    const promise = pullAction.run();
    void toastManager.promise<Awaited<ReturnType<typeof pullAction.run>>>(promise, {
      loading: { title: "Pulling..." },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`
            : `${result.refName} is already synchronized.`,
      }),
      error: (err) => ({ title: "Pull failed", description: errorMessage(err) }),
    });
    void promise.catch(() => undefined);
  }, [pullAction]);

  const onPush = useCallback(
    (publish: boolean) => {
      const promise = pushAction.run();
      void toastManager.promise<Awaited<ReturnType<typeof pushAction.run>>>(promise, {
        loading: { title: publish ? "Publishing branch..." : "Pushing..." },
        success: (result) => ({
          title: result.setUpstream
            ? "Branch published"
            : result.status === "pushed"
              ? "Pushed"
              : "Already up to date",
          description: result.upstreamRef
            ? `${result.refName} → ${result.upstreamRef}`
            : result.refName,
        }),
        error: (err) => ({
          title: publish ? "Publish failed" : "Push failed",
          description: errorMessage(err),
        }),
      });
      void promise.catch(() => undefined);
    },
    [pushAction],
  );

  const onSync = useCallback(
    (mode?: "rebase") => {
      const promise = syncAction.run(mode ? { mode } : undefined);
      void toastManager.promise<Awaited<ReturnType<typeof syncAction.run>>>(promise, {
        loading: { title: mode === "rebase" ? "Rebasing..." : "Syncing..." },
        success: (result) => ({
          title: "Synced",
          description: describeSyncResult(result),
        }),
        error: (err) =>
          isDivergedError(err)
            ? stackedThreadToast({
                type: "error",
                title: "Branch has diverged",
                description: `Local and upstream both changed (${err.aheadCount} ahead, ${err.behindCount} behind). A fast-forward isn't possible.`,
                data: {
                  secondaryActionProps: {
                    children: "Rebase & sync",
                    onClick: () => onSync("rebase"),
                  },
                  secondaryActionVariant: "outline",
                },
              })
            : { title: "Sync failed", description: errorMessage(err) },
      });
      void promise.catch(() => undefined);
    },
    [syncAction],
  );

  // Only meaningful inside a git repo that has a remote to sync against.
  if (!cwd || !status?.isRepo || !status.hasPrimaryRemote) {
    return null;
  }

  const hasUpstream = status.hasUpstream;
  const ahead = status.aheadCount;
  const behind = status.behindCount;
  const busy =
    isRunning ||
    fetchAction.isPending ||
    pullAction.isPending ||
    pushAction.isPending ||
    syncAction.isPending;

  let primary: { content: ReactNode; title: string; onClick: () => void } | null = null;
  if (!hasUpstream) {
    primary = {
      content: (
        <>
          {busy ? <Spinner className="size-3" aria-hidden /> : <UploadIcon className="size-3" />}
          <span>Publish</span>
        </>
      ),
      title: "Publish branch (push and set upstream)",
      onClick: () => onPush(true),
    };
  } else if (ahead > 0 && behind > 0) {
    primary = {
      content: (
        <>
          {busy ? <Spinner className="size-3" aria-hidden /> : <RefreshCwIcon className="size-3" />}
          <SyncCounts ahead={ahead} behind={behind} />
        </>
      ),
      title: `Sync: pull ${behind} and push ${ahead}`,
      onClick: () => onSync(),
    };
  } else if (behind > 0) {
    primary = {
      content: (
        <>
          {busy ? <Spinner className="size-3" aria-hidden /> : <ArrowDownIcon className="size-3" />}
          <span className="tabular-nums">{behind}</span>
        </>
      ),
      title: `Pull ${behind} commit${behind === 1 ? "" : "s"} from upstream`,
      onClick: onPull,
    };
  } else if (ahead > 0) {
    primary = {
      content: (
        <>
          {busy ? <Spinner className="size-3" aria-hidden /> : <ArrowUpIcon className="size-3" />}
          <span className="tabular-nums">{ahead}</span>
        </>
      ),
      title: `Push ${ahead} commit${ahead === 1 ? "" : "s"} to upstream`,
      onClick: () => onPush(false),
    };
  }

  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      {primary ? (
        <Button
          variant="ghost"
          size="xs"
          className="gap-1 px-1.5 text-muted-foreground/70 hover:text-foreground/80"
          disabled={busy}
          onClick={primary.onClick}
          title={primary.title}
        >
          {primary.content}
        </Button>
      ) : (
        <span
          className="inline-flex items-center px-1 text-muted-foreground/45"
          title="Up to date with upstream"
        >
          <CheckIcon className="size-3" aria-hidden />
        </span>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="px-1.5 text-muted-foreground/70 hover:text-foreground/80"
        disabled={busy}
        onClick={onFetch}
        title="Fetch from remote"
      >
        {fetchAction.isPending ? (
          <Spinner className="size-3" aria-hidden />
        ) : (
          <RefreshCwIcon className="size-3" />
        )}
        <span className="sr-only">Fetch</span>
      </Button>
    </div>
  );
}

function SyncCounts({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <span className="inline-flex items-center gap-0.5">
        <ArrowDownIcon className="size-3 opacity-70" aria-hidden />
        {behind}
      </span>
      <span className="inline-flex items-center gap-0.5">
        <ArrowUpIcon className="size-3 opacity-70" aria-hidden />
        {ahead}
      </span>
    </span>
  );
}

function describeSyncResult(result: {
  pull: "pulled" | "rebased" | "skipped_up_to_date" | "skipped";
  push: "pushed" | "skipped";
  setUpstream: boolean;
}): string {
  const parts: string[] = [];
  if (result.pull === "pulled") parts.push("pulled");
  else if (result.pull === "rebased") parts.push("rebased");
  if (result.push === "pushed") parts.push(result.setUpstream ? "published" : "pushed");
  return parts.length > 0 ? `Branch ${parts.join(" and ")}.` : "Already up to date.";
}
