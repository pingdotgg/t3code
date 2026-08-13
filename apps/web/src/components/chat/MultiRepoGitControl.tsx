import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import GitActionsControl from "../GitActionsControl";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { type DraftId } from "~/composerDraftStore";
import { refreshVcsStatusGroup, type VcsStatusState } from "~/lib/vcsStatusState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { vcsActionManager, vcsEnvironment } from "~/state/vcs";
import {
  aggregateRepoStatuses,
  planSyncAll,
  summarizeRepoStatus,
  type SyncAllStep,
} from "./MultiRepoGitControl.logic";

export interface MultiRepoGitGroup {
  readonly repoRoot: string;
  readonly displayName: string;
  readonly state: VcsStatusState;
}

interface MultiRepoGitControlProps {
  groups: ReadonlyArray<MultiRepoGitGroup>;
  environmentId: EnvironmentId;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
}

let nextSyncActionId = 0;

/**
 * Run one repo's batch step against the singleton {@link vcsActionManager}, driving
 * the per-row source-control state atom so each row's own button reflects progress.
 * Throws on failure so the caller's `Promise.allSettled` records a rejection.
 */
async function runSyncStep(environmentId: EnvironmentId, step: SyncAllStep): Promise<void> {
  const target = { environmentId, cwd: step.repoRoot };
  if (step.kind === "pull") {
    // `pull` has no dedicated command on `vcsActionManager`; mirror the single-repo
    // `useVcsPullAction` flow by running the env-level pull command inside `track`
    // so the row's pull state (spinner/error) is managed consistently.
    const result = await vcsActionManager.track(
      appAtomRegistry,
      target,
      { operation: "pull", label: "Pulling latest changes" },
      () =>
        runAtomCommand(appAtomRegistry, vcsEnvironment.pull, {
          environmentId,
          input: { cwd: step.repoRoot },
        }),
    );
    if (result._tag === "Failure") {
      throw new Error(`Pull failed for ${step.displayName}`);
    }
    return;
  }
  nextSyncActionId += 1;
  const result = await runAtomCommand(appAtomRegistry, vcsActionManager.runStackedAction(target), {
    actionId: `multi-repo-sync:${nextSyncActionId}`,
    action: step.action,
  });
  if (result._tag === "Failure") {
    throw new Error(`Source control action failed for ${step.displayName}`);
  }
}

/**
 * Consolidates a multi-repo workspace's per-root git actions into a single
 * "Source Control" button with an aggregate status badge. Opening it reveals one
 * row per repo, each reusing {@link GitActionsControl} (quick action + dropdown +
 * dialogs) scoped to that root — so behaviour matches the single-repo control
 * exactly, just laid out vertically and clearly labelled instead of a cramped
 * horizontal wall of buttons.
 *
 * "Sync all" runs each repo's resolved primary action (commit/push/pull/open
 * request) in parallel via the singleton {@link vcsActionManager}, so every row's
 * own button reflects its progress while one aggregate toast reports the result.
 */
export function MultiRepoGitControl({
  groups,
  environmentId,
  activeThreadRef,
  draftId,
}: MultiRepoGitControlProps) {
  const [isSyncing, setIsSyncing] = useState(false);
  const isSyncingRef = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const repoRoots = useMemo(() => groups.map((group) => group.repoRoot), [groups]);
  const aggregate = useMemo(
    () => aggregateRepoStatuses(groups.map((group) => group.state.data)),
    [groups],
  );
  const plan = useMemo(
    () =>
      planSyncAll(
        groups.map((group) => ({
          repoRoot: group.repoRoot,
          displayName: group.displayName,
          data: group.state.data,
        })),
      ),
    [groups],
  );

  const triggerLabel =
    aggregate.pendingRepos > 0
      ? `Source control — ${aggregate.pendingRepos} of ${aggregate.repoCount} repos need attention`
      : `Source control — ${aggregate.repoCount} repos, all clean`;

  async function executeSyncAll(steps: ReadonlyArray<SyncAllStep>): Promise<void> {
    if (steps.length === 0 || isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      const noun = steps.length === 1 ? "repo" : "repos";
      const toastId = toastManager.add({
        type: "loading",
        title: `Syncing ${steps.length} ${noun}…`,
      });
      const results = await Promise.allSettled(
        steps.map((step) => runSyncStep(environmentId, step)),
      );
      const failures = results
        .map((result, index) => ({ result, step: steps[index]! }))
        .filter((entry) => entry.result.status === "rejected");

      if (failures.length === 0) {
        toastManager.update(toastId, {
          type: "success",
          title: `Synced ${steps.length} ${noun}`,
        });
      } else {
        const failedNames = failures.map((entry) => entry.step.displayName).join(", ");
        const succeeded = steps.length - failures.length;
        toastManager.update(toastId, {
          type: failures.length === steps.length ? "error" : "warning",
          title:
            failures.length === steps.length
              ? `Sync failed for ${failures.length} ${failures.length === 1 ? "repo" : "repos"}`
              : `Synced ${succeeded} of ${steps.length} repos`,
          description: `Failed: ${failedNames}`,
        });
      }
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }

  function handleSyncAll(): void {
    if (plan.steps.length === 0 || isSyncingRef.current) return;
    if (plan.defaultBranchRepos.length > 0) {
      setConfirmOpen(true);
      return;
    }
    void executeSyncAll(plan.steps);
  }

  return (
    <>
      <Popover
        onOpenChange={(open) => {
          if (open) {
            refreshVcsStatusGroup({ environmentId, repoRoots });
          }
        }}
      >
        <PopoverTrigger render={<Button variant="outline" size="xs" aria-label={triggerLabel} />}>
          <GitBranchIcon className="size-3.5" aria-hidden />
          <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
            Source Control
          </span>
          {aggregate.pendingRepos > 0 && (
            <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground">
              {aggregate.pendingRepos}
            </span>
          )}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="end" className="w-80 p-1">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {aggregate.repoCount} {aggregate.repoCount === 1 ? "repo" : "repos"}
            </span>
            {plan.steps.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isSyncing}
                      onClick={handleSyncAll}
                    >
                      {isSyncing ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <RefreshCwIcon className="size-3.5" aria-hidden />
                      )}
                      <span className="ml-0.5">Sync all</span>
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">
                  Run the primary action for {plan.steps.length}{" "}
                  {plan.steps.length === 1 ? "repo" : "repos"}
                  {plan.skipped.length > 0 ? ` (${plan.skipped.length} need manual steps)` : ""}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
          <div className="flex flex-col">
            {groups.map((group) => (
              <div
                key={group.repoRoot}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
              >
                <div className="flex min-w-0 flex-col">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="truncate text-sm font-medium text-foreground">
                          {group.displayName}
                        </span>
                      }
                    />
                    <TooltipPopup side="left">{group.repoRoot}</TooltipPopup>
                  </Tooltip>
                  <span className="truncate text-xs text-muted-foreground">
                    {summarizeRepoStatus(group.state.data, group.state.isPending)}
                  </span>
                </div>
                <GitActionsControl
                  gitCwd={group.repoRoot}
                  activeThreadRef={activeThreadRef}
                  syncThreadBranch={false}
                  quickActionLabel="always"
                  {...(draftId ? { draftId } : {})}
                />
              </div>
            ))}
          </div>
        </PopoverPopup>
      </Popover>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Push to default branch?</DialogTitle>
            <DialogDescription>
              These repos will commit and push directly to their default branch:{" "}
              {plan.defaultBranchRepos.join(", ")}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isSyncing}
              onClick={() => {
                setConfirmOpen(false);
                void executeSyncAll(plan.steps);
              }}
            >
              Sync all
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
