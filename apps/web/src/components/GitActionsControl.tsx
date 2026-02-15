import {
  type GitStatusResult,
  type GitStackedAction,
  type NativeApi,
} from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { ChevronDownIcon, CloudUploadIcon, GitCommitIcon, InfoIcon } from "lucide-react";
import { GitHubIcon } from "./Icons";
import {
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitDialogAction,
  type GitQuickAction,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import { Badge } from "~/components/ui/badge";
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

function formatUpstreamStatus(input: {
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
}): string {
  if (!input.hasUpstream) return "No upstream configured";
  if (input.aheadCount === 0 && input.behindCount === 0) return "Up to date";
  if (input.aheadCount > 0 && input.behindCount > 0) {
    return `Diverged (+${input.aheadCount} / -${input.behindCount})`;
  }
  if (input.aheadCount > 0) return `Ahead by ${input.aheadCount}`;
  return `Behind by ${input.behindCount}`;
}

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function GitQuickActionIcon({ quickAction }: { quickAction: GitQuickAction }) {
  if (quickAction.kind === "open_pr") return <GitHubIcon className="size-4" />;
  if (quickAction.kind === "run_pull") return <InfoIcon className="size-4" />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className="size-4" />;
    if (quickAction.action === "commit_push") return <CloudUploadIcon className="size-4" />;
    return <GitHubIcon className="size-4" />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className="size-4" />;
  return <InfoIcon className="size-4" />;
}

function buildGitActionProgressStages(input: {
  action: GitStackedAction;
  hasCustomCommitMessage: boolean;
}): string[] {
  const commitStages = input.hasCustomCommitMessage
    ? ["Committing..."]
    : ["Generating commit message...", "Committing..."];
  if (input.action === "commit") {
    return commitStages;
  }
  if (input.action === "commit_push") {
    return [...commitStages, "Pushing..."];
  }
  return [...commitStages, "Pushing...", "Creating PR..."];
}

export default function GitActionsControl({ api, gitCwd }: GitActionsControlProps) {
  const queryClient = useQueryClient();
  const [activeDialogAction, setActiveDialogAction] = useState<GitDialogAction | null>(null);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");

  const { data: gitStatus = null, error: gitStatusError } = useQuery(
    gitStatusQueryOptions(api, gitCwd),
  );

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(api, gitCwd));
  // Default to true while loading so we don't flash init controls.
  const isRepo = branchList?.isRepo ?? true;

  const initMutation = useMutation(gitInitMutationOptions({ api, cwd: gitCwd, queryClient }));

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({ api, cwd: gitCwd, queryClient }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ api, cwd: gitCwd, queryClient }));

  const isGitActionRunning = runImmediateGitActionMutation.isPending || pullMutation.isPending;
  const isDefaultBranch = useMemo(() => {
    const currentBranch = gitStatus?.branch;
    if (!currentBranch) return false;
    const current = branchList?.branches.find((branch) => branch.name === currentBranch);
    return current?.isDefault ?? (currentBranch === "main" || currentBranch === "master");
  }, [branchList?.branches, gitStatus?.branch]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatus, isGitActionRunning),
    [gitStatus, isGitActionRunning],
  );
  const quickAction = useMemo(
    () => resolveQuickAction(gitStatus, isGitActionRunning, isDefaultBranch),
    [gitStatus, isDefaultBranch, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const [isQuickActionPopoverOpen, setIsQuickActionPopoverOpen] = useState(false);
  const [openDisabledMenuItemId, setOpenDisabledMenuItemId] = useState<GitActionMenuItem["id"] | null>(
    null,
  );

  const refreshGitStatus = useCallback(async () => {
    if (!api || !gitCwd) return;
    await invalidateGitQueries(queryClient);
  }, [api, gitCwd, queryClient]);

  const maybeConfirmPushToDefaultBranch = useCallback(
    async (action: GitStackedAction): Promise<boolean> => {
      if (!api) return false;
      if (!requiresDefaultBranchConfirmation(action, isDefaultBranch) || !gitStatus?.branch) {
        return true;
      }
      return api.dialogs.confirm(
        `Push to default branch "${gitStatus.branch}"? This will update the shared base branch.`,
      );
    },
    [api, gitStatus?.branch, isDefaultBranch],
  );

  const openExistingPr = useCallback(async () => {
    if (!api) {
      toastManager.add({ type: "error", title: "Link opening is unavailable." });
      return;
    }
    const prUrl = gitStatus?.openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({ type: "error", title: "No open PR found." });
      return;
    }
    const promise = api.shell.openExternal(prUrl);
    toastManager.promise(promise, {
      loading: { title: "Opening PR..." },
      success: { title: "PR opened" },
      error: (err) => ({
        title: "Unable to open PR link",
        description: err instanceof Error ? err.message : "An error occurred.",
      }),
    });
    void promise.catch(() => undefined);
  }, [api, gitStatus?.openPr?.url]);

  const runGitActionWithToast = useCallback(
    async ({
      action,
      commitMessage,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
    }) => {
      const confirmed = await maybeConfirmPushToDefaultBranch(action);
      if (!confirmed) return;

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
      });
      const progressToastId = toastManager.add({
        type: "loading",
        title: progressStages[0] ?? "Running git action...",
        timeout: 0,
      });

      let stageIndex = 0;
      const stageInterval = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, progressStages.length - 1);
        toastManager.update(progressToastId, {
          title: progressStages[stageIndex] ?? "Running git action...",
          type: "loading",
          timeout: 0,
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

        const prUrl = result.pr.url ?? gitStatus?.openPr?.url;
        const shouldOfferPushCta = action === "commit" && result.commit.status === "created";
        const shouldOfferOpenPrCta =
          (action === "commit_push" || action === "commit_push_pr") && !!prUrl;
        const shouldOfferCreatePrCta =
          action === "commit_push" && !prUrl && result.push.status === "pushed";

        toastManager.update(progressToastId, {
          type: "success",
          title: resultToast.title,
          description: resultToast.description,
          timeout: 10_000,
          ...(shouldOfferPushCta
            ? {
                actionProps: {
                  children: "Push",
                  onClick: () => setActiveDialogAction("push"),
                },
              }
            : shouldOfferOpenPrCta
              ? {
                  actionProps: {
                    children: "Open PR",
                    onClick: () => void api?.shell.openExternal(prUrl),
                  },
                }
              : shouldOfferCreatePrCta
                ? {
                    actionProps: {
                      children: "Create PR",
                      onClick: () => setActiveDialogAction("create_pr"),
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
        });
      }
    },
    [
      api,
      gitStatus?.openPr?.url,
      maybeConfirmPushToDefaultBranch,
      runImmediateGitActionMutation,
      setActiveDialogAction,
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
        loading: { title: "Pulling..." },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.branch} from ${result.upstreamBranch ?? "upstream"}`
              : `${result.branch} is already synchronized.`,
        }),
        error: (err) => ({
          title: "Pull failed",
          description: err instanceof Error ? err.message : "An error occurred.",
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
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  }, [openExistingPr, pullMutation, quickAction, runGitActionWithToast]);

  const openDialogForMenuItem = useCallback(
    (item: GitActionMenuItem) => {
      if (item.disabled) return;
      if (item.kind === "open_pr") {
        void openExistingPr();
        return;
      }
      if (item.dialogAction) {
        setActiveDialogAction(item.dialogAction);
      }
    },
    [openExistingPr],
  );

  const runDialogAction = useCallback(() => {
    if (!activeDialogAction) return;
    const action: GitStackedAction =
      activeDialogAction === "commit"
        ? "commit"
        : activeDialogAction === "push"
          ? "commit_push"
          : "commit_push_pr";
    const commitMessage =
      activeDialogAction === "commit" ? dialogCommitMessage.trim() : "";
    setActiveDialogAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
    });
  }, [activeDialogAction, dialogCommitMessage, runGitActionWithToast]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void api.shell.openInEditor(target, preferredTerminalEditor()).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [api, gitCwd],
  );

  const dialogTitle =
    activeDialogAction === "commit"
      ? "Commit changes"
      : activeDialogAction === "push"
        ? "Push branch"
        : "Create pull request";
  const dialogDescription =
    activeDialogAction === "commit"
      ? "Review and confirm your commit. Leave the message blank to auto-generate one."
      : activeDialogAction === "push"
        ? "Push this branch now. If this is the default branch, you'll be asked to confirm."
        : "Create a pull request using generated title/body content.";
  const showCompactStatusCard =
    !!gitStatus && gitStatus.hasWorkingTreeChanges && !gitStatus.hasUpstream;

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
            <Popover open={isQuickActionPopoverOpen} onOpenChange={setIsQuickActionPopoverOpen}>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={isGitActionRunning || quickAction.disabled}
                    className="cursor-not-allowed disabled:cursor-not-allowed disabled:pointer-events-auto"
                    onMouseEnter={() => setIsQuickActionPopoverOpen(true)}
                    onMouseLeave={() => setIsQuickActionPopoverOpen(false)}
                  />
                }
              >
                <GitQuickActionIcon quickAction={quickAction} />
                {quickAction.label}
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
              {quickAction.label}
            </Button>
          )}
          <GroupSeparator />
          <Menu
            onOpenChange={(open) => {
              if (open) void refreshGitStatus();
              if (!open) setOpenDisabledMenuItemId(null);
            }}
          >
            <MenuTrigger
              render={<Button aria-label="Git action options" size="icon-xs" variant="outline" />}
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" sideOffset={4}>
              {gitActionMenuItems.map((item) => {
                const disabledReason = getMenuActionDisabledReason(item, gitStatus, isGitActionRunning);
                if (item.disabled && disabledReason) {
                  return (
                    <Popover
                      key={`${item.id}-${item.label}`}
                      open={openDisabledMenuItemId === item.id}
                      onOpenChange={(open) => setOpenDisabledMenuItemId(open ? item.id : null)}
                    >
                      <PopoverTrigger
                        render={
                          <span
                            className="inline-flex w-full cursor-not-allowed"
                            onMouseEnter={() => setOpenDisabledMenuItemId(item.id)}
                            onMouseLeave={() => setOpenDisabledMenuItemId(null)}
                          />
                        }
                      >
                        <MenuItem disabled>
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
              {gitStatus?.branch === null && (
                <p className="px-2 py-1.5 text-xs text-warning">
                  Detached HEAD: create and checkout a branch to enable push and PR actions.
                </p>
              )}
              {gitStatus &&
                gitStatus.branch !== null &&
                !gitStatus.hasWorkingTreeChanges &&
                gitStatus.behindCount > 0 && (
                  <p className="px-2 py-1.5 text-xs text-warning">
                    Behind upstream. Pull/rebase first.
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
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-lg border border-input bg-muted/40 p-3 text-xs">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="font-medium">{gitStatus?.branch ?? "(detached HEAD)"}</span>
                {!showCompactStatusCard && (
                  <>
                    <span className="text-muted-foreground">Upstream</span>
                    <span className="font-medium">
                      {gitStatus
                        ? formatUpstreamStatus({
                            hasUpstream: gitStatus.hasUpstream,
                            aheadCount: gitStatus.aheadCount,
                            behindCount: gitStatus.behindCount,
                          })
                        : "unknown"}
                    </span>
                    <span className="text-muted-foreground">Working tree</span>
                    <span className="font-medium">
                      {!gitStatus || !gitStatus.hasWorkingTreeChanges
                        ? "Clean"
                        : `${gitStatus.workingTree.files.length} file(s)`}
                    </span>
                    <span className="text-muted-foreground">Diff</span>
                    <span className="font-mono">
                      {!gitStatus || !gitStatus.hasWorkingTreeChanges ? (
                        "none"
                      ) : (
                        <>
                          <span className="text-success">+{gitStatus.workingTree.insertions}</span>
                          <span className="text-muted-foreground"> / </span>
                          <span className="text-destructive">-{gitStatus.workingTree.deletions}</span>
                        </>
                      )}
                    </span>
                  </>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Files</p>
                {!gitStatus || gitStatus.workingTree.files.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-1">
                    {gitStatus.workingTree.files.slice(0, 6).map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        className="flex w-full items-center justify-between gap-3 rounded-md border border-input bg-background px-2 py-1 font-mono text-left transition-colors hover:bg-accent/50"
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
                    {gitStatus.workingTree.files.length > 6 && (
                      <Badge variant="outline" size="sm">
                        +{gitStatus.workingTree.files.length - 6} more
                      </Badge>
                    )}
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
