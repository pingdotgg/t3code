import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
    const toastId = toastManager.add({ type: "loading", title: "Fetching...", timeout: 0 });
    void (async () => {
      const result = await fetchAction.run();
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(toastId);
          return;
        }
        toastManager.update(toastId, {
          type: "error",
          title: "Fetch failed",
          description: errorMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      // vcs.fetch only updates remote-tracking refs; the branch may now be ahead
      // or behind, so don't claim "Up to date" here — the badge reflects the state.
      toastManager.update(toastId, {
        type: "success",
        title: "Fetched",
        description: "Updated remote-tracking refs.",
      });
    })();
  }, [fetchAction]);

  const onPull = useCallback(() => {
    const toastId = toastManager.add({ type: "loading", title: "Pulling...", timeout: 0 });
    void (async () => {
      const result = await pullAction.run();
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(toastId);
          return;
        }
        toastManager.update(toastId, {
          type: "error",
          title: "Pull failed",
          description: errorMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      const value = result.value;
      toastManager.update(toastId, {
        type: "success",
        title: value.status === "pulled" ? "Pulled" : "Already up to date",
        description:
          value.status === "pulled"
            ? `Updated ${value.refName} from ${value.upstreamRef ?? "upstream"}`
            : `${value.refName} is already synchronized.`,
      });
    })();
  }, [pullAction]);

  const onPush = useCallback(
    (publish: boolean) => {
      const toastId = toastManager.add({
        type: "loading",
        title: publish ? "Publishing branch..." : "Pushing...",
        timeout: 0,
      });
      void (async () => {
        const result = await pushAction.run();
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            toastManager.close(toastId);
            return;
          }
          toastManager.update(toastId, {
            type: "error",
            title: publish ? "Publish failed" : "Push failed",
            description: errorMessage(squashAtomCommandFailure(result)),
          });
          return;
        }
        const value = result.value;
        toastManager.update(toastId, {
          type: "success",
          title: value.setUpstream
            ? "Branch published"
            : value.status === "pushed"
              ? "Pushed"
              : "Already up to date",
          description: value.upstreamRef
            ? `${value.refName} → ${value.upstreamRef}`
            : value.refName,
        });
      })();
    },
    [pushAction],
  );

  const onSync = useCallback(
    (mode?: "rebase") => {
      const toastId = toastManager.add({
        type: "loading",
        title: mode === "rebase" ? "Rebasing..." : "Syncing...",
        timeout: 0,
      });
      void (async () => {
        const result = await syncAction.run(mode ? { mode } : undefined);
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            toastManager.close(toastId);
            return;
          }
          const error = squashAtomCommandFailure(result);
          if (isDivergedError(error)) {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type: "error",
                title: "Branch has diverged",
                description: `Local and upstream both changed (${error.aheadCount} ahead, ${error.behindCount} behind). A fast-forward isn't possible.`,
                data: {
                  secondaryActionProps: {
                    children: "Rebase & sync",
                    onClick: () => onSync("rebase"),
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
            return;
          }
          toastManager.update(toastId, {
            type: "error",
            title: "Sync failed",
            description: errorMessage(error),
          });
          return;
        }
        toastManager.update(toastId, {
          type: "success",
          title: "Synced",
          description: describeSyncResult(result.value),
        });
      })();
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
