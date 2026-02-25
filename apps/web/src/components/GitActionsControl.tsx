import { type GitStatusResult, type GitStackedAction, type NativeApi } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, CloudUploadIcon, GitCommitIcon, InfoIcon } from "lucide-react";
import { GitHubIcon } from "./Icons";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitDialogAction,
  type GitQuickAction,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import {
  gitBranchesQueryOptions,
  gitInitMutationOptions,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { preferredTerminalEditor, resolvePathLinkTarget } from "~/terminal-links";

interface GitActionsControlProps {
  api: NativeApi | undefined;
  gitCwd: string | null;
  activeThreadId: string | null;
}

function getMenuActionDisabledReason(
  item: GitActionMenuItem,
  gitStatus: GitStatusResult | null,
  isBusy: boolean,
): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.branch !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.openPr !== null;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: checkout a branch before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return "Open PR is currently unavailable.";
  }
  if (!hasBranch) {
    return "Detached HEAD: checkout a branch before creating a PR.";
  }
  if (hasChanges) {
    return "Commit local changes before creating a PR.";
  }
  if (!isAhead) {
    return "No local commits to include in a PR.";
  }
  if (!gitStatus.hasUpstream) {
    return "Set an upstream branch before creating a PR.";
  }
  if (isBehind) {
    return "Branch is behind upstream. Pull/rebase before creating a PR.";
  }
  return "Create PR is currently unavailable.";
}

const DIALOG_TITLE_BY_ACTION = {
  commit: "Commit changes",
  push: "Push branch",
  create_pr: "Create pull request",
};

const DIALOG_DESCRIPTION_BY_ACTION = {
  commit: "Review and confirm your commit. Leave the message blank to auto-generate one.",
  push: "Push this branch now.",
  create_pr: "Create a pull request using generated title/body content.",
};

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <GitHubIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <InfoIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "commit_push") return <CloudUploadIcon className={iconClassName} />;
    return <GitHubIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

export default function GitActionsControl({
  api,
  gitCwd,
  activeThreadId,
}: GitActionsControlProps) {
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [activeDialogAction, setActiveDialogAction] = useState<GitDialogAction | null>(null);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");

  const { data: gitStatus = null, error: gitStatusError } = useQuery(
    gitStatusQueryOptions(api, gitCwd),
  );

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(api, gitCwd));
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  const isGitStatusOutOfSync =
    !!gitStatus?.branch && !!currentBranch && gitStatus.branch !== currentBranch;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    void invalidateGitQueries(queryClient);
  }, [isGitStatusOutOfSync, queryClient]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const initMutation = useMutation(gitInitMutationOptions({ api, cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({ api, cwd: gitCwd, queryClient }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ api, cwd: gitCwd, queryClient }));

  const isGitActionRunning = runImmediateGitActionMutation.isPending || pullMutation.isPending;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning),
    [gitStatusForActions, isGitActionRunning],
  );
  const quickAction = useMemo(
    () => resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultBranch),
    [gitStatusForActions, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;

  const maybeConfirmPushToDefaultBranch = useCallback(
    async (action: GitStackedAction): Promise<boolean> => {
      if (!api) return false;
      if (
        !requiresDefaultBranchConfirmation(action, isDefaultBranch) ||
        !gitStatusForActions?.branch
      ) {
        return true;
      }
      return api.dialogs.confirm(
        `You're about to push to the default branch "${gitStatusForActions.branch}". Continue?`,
      );
    },
    [api, gitStatusForActions?.branch, isDefaultBranch],
  );

  const openExistingPr = useCallback(async () => {
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [api, gitStatusForActions?.openPr?.url, threadToastData]);

  const runGitActionWithToast = useCallback(
    async ({
      action,
      commitMessage,
      forcePushOnlyProgress = false,
      onConfirmed,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
      forcePushOnlyProgress?: boolean;
      onConfirmed?: () => void;
    }) => {
      const confirmed = await maybeConfirmPushToDefaultBranch(action);
      if (!confirmed) return;
      onConfirmed?.();

      const pushTarget = gitStatusForActions?.branch
        ? `origin/${gitStatusForActions.branch}`
        : undefined;
      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!gitStatusForActions?.hasWorkingTreeChanges,
        forcePushOnly: forcePushOnlyProgress,
        ...(pushTarget ? { pushTarget } : {}),
      });
      const progressToastId = toastManager.add({
        type: "loading",
        title: progressStages[0] ?? "Running git action...",
        timeout: 0,
        data: threadToastData,
      });

      let stageIndex = 0;
      const stageInterval = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, progressStages.length - 1);
        toastManager.update(progressToastId, {
          title: progressStages[stageIndex] ?? "Running git action...",
          type: "loading",
          timeout: 0,
          data: threadToastData,
        });
      }, 1100);

      const stopProgressUpdates = () => {
        clearInterval(stageInterval);
      };

      const promise = runImmediateGitActionMutation.mutateAsync({
        action,
        ...(commitMessage ? { commitMessage } : {}),
      });

      try {
        const result = await promise;
        stopProgressUpdates();
        const resultToast = summarizeGitResult(result);

        const prUrl = result.pr.url ?? gitStatusForActions?.openPr?.url;
        const shouldOfferPushCta = action === "commit" && result.commit.status === "created";
        const shouldOfferOpenPrCta =
          (action === "commit_push" || action === "commit_push_pr") && !!prUrl && !isDefaultBranch;
        const shouldOfferCreatePrCta =
          action === "commit_push" && !prUrl && result.push.status === "pushed" && !isDefaultBranch;
        const closeResultToast = () => {
          toastManager.close(progressToastId);
        };

        toastManager.update(progressToastId, {
          type: "success",
          title: resultToast.title,
          description: resultToast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
          ...(shouldOfferPushCta
            ? {
                actionProps: {
                  children: "Push",
                  onClick: () => {
                    void runGitActionWithToast({
                      action: "commit_push",
                      forcePushOnlyProgress: true,
                      onConfirmed: closeResultToast,
                    });
                  },
                },
              }
            : shouldOfferOpenPrCta
              ? {
                  actionProps: {
                    children: "Open PR",
                    onClick: () => {
                      closeResultToast();
                      void api?.shell.openExternal(prUrl);
                    },
                  },
                }
              : shouldOfferCreatePrCta
                ? {
                    actionProps: {
                      children: "Create PR",
                      onClick: () => {
                        closeResultToast();
                        setActiveDialogAction("create_pr");
                      },
                    },
                  }
                : {}),
        });
      } catch (err) {
        stopProgressUpdates();
        toastManager.update(progressToastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [
      api,
      gitStatusForActions?.branch,
      gitStatusForActions?.hasWorkingTreeChanges,
      gitStatusForActions?.openPr?.url,
      isDefaultBranch,
      maybeConfirmPushToDefaultBranch,
      runImmediateGitActionMutation,
      setActiveDialogAction,
      threadToastData,
    ],
  );

  const runQuickAction = useCallback(() => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      const promise = pullMutation.mutateAsync();
      toastManager.promise(promise, {
        loading: { title: "Pulling...", data: threadToastData },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
              : `${result.branch} is already synchronized.`,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });
      void promise.catch(() => undefined);
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [openExistingPr, pullMutation, quickAction, runGitActionWithToast, threadToastData]);

  const openDialogForMenuItem = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (item.dialogAction === "push") {
        void runGitActionWithToast({ action: "commit_push", forcePushOnlyProgress: true });
        return;
      }
      if (item.dialogAction) {
        setActiveDialogAction(item.dialogAction);
      }
    },
    [openExistingPr, runGitActionWithToast],
  );

  const runDialogAction = useCallback(() => {
    if (!activeDialogAction) return;
    const action: GitStackedAction =
      activeDialogAction === "commit"
        ? "commit"
        : activeDialogAction === "push"
          ? "commit_push"
          : "commit_push_pr";
    const commitMessage = activeDialogAction === "commit" ? dialogCommitMessage.trim() : "";
    const forcePushOnlyProgress = activeDialogAction === "push";
    setActiveDialogAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(forcePushOnlyProgress ? { forcePushOnlyProgress } : {}),
    });
  }, [activeDialogAction, dialogCommitMessage, runGitActionWithToast]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void api.shell.openInEditor(target, preferredTerminalEditor()).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [api, gitCwd, threadToastData],
  );

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <Button
          variant="outline"
          size="xs"
          disabled={initMutation.isPending}
          onClick={() => initMutation.mutate()}
        >
          {initMutation.isPending ? "Initializing..." : "Initialize Git"}
        </Button>
      ) : (
        <Group aria-label="Git actions">
          {quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <Button
                    aria-disabled="true"
                    className="cursor-not-allowed rounded-e-none border-e-0 opacity-64 before:rounded-e-none"
                    size="xs"
                    variant="outline"
                  />
                }
              >
                <GitQuickActionIcon quickAction={quickAction} />
                <span className="sr-only sm:not-sr-only sm:ml-0.5">{quickAction.label}</span>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button
              variant="outline"
              size="xs"
              disabled={isGitActionRunning || quickAction.disabled}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon quickAction={quickAction} />
              <span className="sr-only sm:not-sr-only sm:ml-0.5">{quickAction.label}</span>
            </Button>
          )}
          <GroupSeparator className="hidden sm:block" />
          <Menu
            onOpenChange={(open) => {
              if (open) void invalidateGitQueries(queryClient);
            }}
          >
            <MenuTrigger
              render={<Button aria-label="Git action options" size="icon-xs" variant="outline" />}
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-full">
              {gitActionMenuItems.map((item) => {
                const disabledReason = getMenuActionDisabledReason(
                  item,
                  gitStatusForActions,
                  isGitActionRunning,
                );
                if (item.disabled && disabledReason) {
                  return (
                    <Popover key={`${item.id}-${item.label}`}>
                      <PopoverTrigger
                        openOnHover
                        nativeButton={false}
                        render={<span className="block w-max cursor-not-allowed" />}
                      >
                        <MenuItem className="w-full" disabled>
                          <GitActionItemIcon icon={item.icon} />
                          {item.label}
                        </MenuItem>
                      </PopoverTrigger>
                      <PopoverPopup tooltipStyle side="left" align="center">
                        {disabledReason}
                      </PopoverPopup>
                    </Popover>
                  );
                }

                return (
                  <MenuItem
                    key={`${item.id}-${item.label}`}
                    disabled={item.disabled}
                    onClick={() => {
                      openDialogForMenuItem(item);
                    }}
                  >
                    <GitActionItemIcon icon={item.icon} />
                    {item.label}
                  </MenuItem>
                );
              })}
              {gitStatusForActions?.branch === null && (
                <p className="px-2 py-1.5 text-xs text-warning">
                  Detached HEAD: create and checkout a branch to enable push and PR actions.
                </p>
              )}
              {gitStatusForActions &&
                gitStatusForActions.branch !== null &&
                !gitStatusForActions.hasWorkingTreeChanges &&
                gitStatusForActions.behindCount > 0 &&
                gitStatusForActions.aheadCount === 0 && (
                  <p className="px-2 py-1.5 text-xs text-warning">
                    Behind upstream. Pull/rebase first.
                  </p>
                )}
              {isGitStatusOutOfSync && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  Refreshing git status...
                </p>
              )}
              {gitStatusError && (
                <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError.message}</p>
              )}
            </MenuPopup>
          </Menu>
        </Group>
      )}

      <Dialog
        open={activeDialogAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialogAction(null);
            setDialogCommitMessage("");
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{DIALOG_TITLE_BY_ACTION[activeDialogAction ?? "commit"]}</DialogTitle>
            <DialogDescription>
              {DIALOG_DESCRIPTION_BY_ACTION[activeDialogAction ?? "commit"]}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-lg border border-input bg-muted/40 p-3 text-xs">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="font-medium">
                  {gitStatusForActions?.branch ?? "(detached HEAD)"}
                </span>
                {activeDialogAction !== "commit" && (
                  <>
                    <span className="text-muted-foreground">Upstream</span>
                    <span className="font-medium">
                      {!gitStatusForActions || !gitStatusForActions.hasUpstream
                        ? "No upstream configured"
                        : gitStatusForActions.aheadCount === 0 &&
                            gitStatusForActions.behindCount === 0
                          ? "Up to date"
                          : gitStatusForActions.aheadCount > 0 &&
                              gitStatusForActions.behindCount > 0
                            ? `Diverged (+${gitStatusForActions.aheadCount} / -${gitStatusForActions.behindCount})`
                            : gitStatusForActions.aheadCount > 0
                              ? `Ahead by ${gitStatusForActions.aheadCount}`
                              : `Behind by ${gitStatusForActions.behindCount}`}
                    </span>
                    <span className="text-muted-foreground">Working tree</span>
                    <span className="font-medium">
                      {!gitStatusForActions || !gitStatusForActions.hasWorkingTreeChanges
                        ? "Clean"
                        : `${gitStatusForActions.workingTree.files.length} file(s)`}
                    </span>
                    <span className="text-muted-foreground">Diff</span>
                    <span className="font-mono">
                      {!gitStatusForActions || !gitStatusForActions.hasWorkingTreeChanges ? (
                        "none"
                      ) : (
                        <>
                          <span className="text-success">
                            +{gitStatusForActions.workingTree.insertions}
                          </span>
                          <span className="text-muted-foreground"> / </span>
                          <span className="text-destructive">
                            -{gitStatusForActions.workingTree.deletions}
                          </span>
                        </>
                      )}
                    </span>
                  </>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Files</p>
                {!gitStatusForActions || gitStatusForActions.workingTree.files.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-md border border-input bg-background">
                      <div className="space-y-1 p-1">
                        {gitStatusForActions.workingTree.files.map((file) => (
                          <button
                            type="button"
                            key={file.path}
                            className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 font-mono text-left transition-colors hover:bg-accent/50"
                            onClick={() => openChangedFileInEditor(file.path)}
                          >
                            <span className="truncate">{file.path}</span>
                            <span className="shrink-0">
                              <span className="text-success">+{file.insertions}</span>
                              <span className="text-muted-foreground"> / </span>
                              <span className="text-destructive">-{file.deletions}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono">
                      <span className="text-success">
                        +{gitStatusForActions.workingTree.insertions}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">
                        -{gitStatusForActions.workingTree.deletions}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {activeDialogAction === "commit" && (
              <div className="space-y-1">
                <p className="text-xs font-medium">Commit message (optional)</p>
                <Textarea
                  value={dialogCommitMessage}
                  onChange={(event) => setDialogCommitMessage(event.target.value)}
                  placeholder="Leave empty to auto-generate"
                  size="sm"
                />
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setActiveDialogAction(null);
                setDialogCommitMessage("");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={runDialogAction}>
              {activeDialogAction === "commit"
                ? "Commit"
                : activeDialogAction === "push"
                  ? "Push"
                  : "Create PR"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
