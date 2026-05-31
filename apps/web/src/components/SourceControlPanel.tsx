import { scopeThreadRef } from "@t3tools/client-runtime";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestArrowIcon,
  ListTreeIcon,
  MinusIcon,
  PanelRightCloseIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { openWorkspaceFilePreview } from "../workspaceFilePreview";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore, selectProjectByRef } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { useTheme } from "../hooks/useTheme";
import { resolveThreadRouteTarget } from "../threadRoutes";
import {
  readSourceControlPanelScrollTop,
  recordSourceControlPanelCollapsedDirs,
  recordSourceControlPanelScrollTop,
  recordSourceControlPanelViewMode,
  sourceControlPanelScrollKey,
  useSetSourceControlCommitMessage,
  useSourceControlPanelState,
  useSourceControlPanelWorkspaceViewState,
} from "../sourceControlPanelState";
import {
  buildMenuItems,
  getMenuActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  type GitActionMenuItem,
} from "./GitActionsControl.logic";
import { SourceControlPublishDialog } from "./SourceControlPublishDialog";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import {
  buildSourceControlTree,
  sourceControlFileName,
  statusBadge,
  type SourceControlTreeNode,
} from "./sourceControlTree";
import { useGitActionRunner } from "./useGitActionRunner";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { ScrollArea } from "./ui/scroll-area";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  gitGenerateCommitMessageMutationOptions,
  gitMutationKeys,
  vcsStageFilesMutationOptions,
  vcsUnstageFilesMutationOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus } from "~/lib/gitStatusState";
import { cn } from "~/lib/utils";

export type SourceControlPanelMode = "sidebar" | "sheet";
type SourceControlSection = "staged" | "unstaged";

interface SourceControlPanelProps {
  mode?: SourceControlPanelMode;
  onClose: () => void;
}

function commitMessageProps(commitMessage: string): { commitMessage?: string } {
  return commitMessage.trim().length > 0 ? { commitMessage } : {};
}

function commitAndPushDisabledReason(input: {
  gitStatus: ReturnType<typeof useGitActionRunner>["gitStatus"];
  isGitActionRunning: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  if (input.isGitActionRunning) return "Git action in progress.";
  if (!input.gitStatus) return "Git status is unavailable.";
  if (!input.gitStatus.hasWorkingTreeChanges) {
    return "Worktree is clean. Make changes before committing.";
  }
  if (input.gitStatus.refName === null) return "Detached HEAD: checkout a refName before pushing.";
  if (input.gitStatus.behindCount > 0) {
    return "Branch is behind upstream. Pull/rebase before pushing.";
  }
  if (!input.gitStatus.hasUpstream && !input.hasPrimaryRemote) {
    return 'Add an "origin" remote before pushing.';
  }
  return null;
}

function pullDisabledReason(input: {
  gitStatus: ReturnType<typeof useGitActionRunner>["gitStatus"];
  isGitActionRunning: boolean;
}): string | null {
  if (input.isGitActionRunning) return "Git action in progress.";
  if (!input.gitStatus) return "Git status is unavailable.";
  if (input.gitStatus.refName === null) return "Detached HEAD: checkout a refName before pulling.";
  if (!input.gitStatus.hasUpstream) return "No upstream branch is configured.";
  if (input.gitStatus.behindCount === 0) return "Branch is already up to date.";
  return null;
}

function getSourceControlScrollViewport(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

function useSourceControlScrollRestoration(input: {
  layoutKey: string;
  rootRef: RefObject<HTMLElement | null>;
  workspaceKey: string | null;
}): void {
  useLayoutEffect(() => {
    const workspaceKey = input.workspaceKey;
    if (!workspaceKey) {
      return;
    }

    const viewport = getSourceControlScrollViewport(input.rootRef.current);
    if (!viewport) {
      return;
    }

    const restoreScrollTop = () => {
      viewport.scrollTop = readSourceControlPanelScrollTop(workspaceKey);
    };
    restoreScrollTop();

    const frameId = window.requestAnimationFrame(restoreScrollTop);
    return () => window.cancelAnimationFrame(frameId);
  }, [input.layoutKey, input.rootRef, input.workspaceKey]);

  useEffect(() => {
    const workspaceKey = input.workspaceKey;
    if (!workspaceKey) {
      return;
    }

    const viewport = getSourceControlScrollViewport(input.rootRef.current);
    if (!viewport) {
      return;
    }

    const recordScrollTop = () => {
      recordSourceControlPanelScrollTop(workspaceKey, viewport.scrollTop);
    };
    viewport.addEventListener("scroll", recordScrollTop, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", recordScrollTop);
    };
  }, [input.rootRef, input.workspaceKey]);
}

export default function SourceControlPanel({ mode = "sidebar", onClose }: SourceControlPanelProps) {
  const { commitMessage } = useSourceControlPanelState();
  const setCommitMessage = useSetSourceControlCommitMessage();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<SourceControlSection>>(
    () => new Set(),
  );
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [pendingStagePaths, setPendingStagePaths] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingUnstagePaths, setPendingUnstagePaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const draftSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const serverRouteDraftSession = useComposerDraftStore((store) =>
    routeThreadRef ? store.getDraftSessionByRef(routeThreadRef) : null,
  );
  const context = serverThread ?? serverRouteDraftSession ?? draftSession ?? null;
  const environmentId = context?.environmentId ?? null;
  const projectId = context?.projectId ?? null;
  const activeThreadRef = useMemo(() => {
    if (routeThreadRef) return routeThreadRef;
    if (!context) return null;
    return scopeThreadRef(context.environmentId, "id" in context ? context.id : context.threadId);
  }, [context, routeThreadRef]);
  const project = useStore((store) =>
    environmentId && projectId
      ? selectProjectByRef(store, { environmentId, projectId })
      : undefined,
  );
  const cwd = context?.worktreePath ?? project?.cwd ?? null;

  const runner = useGitActionRunner({
    gitCwd: cwd,
    environmentId,
    activeThreadRef,
    draftId: routeDraftId,
  });
  const {
    gitStatus,
    gitStatusError,
    isRepo,
    hasPrimaryRemote,
    isDefaultRef,
    isGitActionRunning: isGitActionRunningRaw,
    isFinalizingAction,
    runGitActionWithToast,
    runPull,
    openExistingPr,
    initMutation,
    pendingDefaultBranchAction,
    setPendingDefaultBranchAction,
    continuePendingDefaultBranchAction,
    checkoutFeatureBranchAndContinuePendingAction,
    sourceControlPresentation,
  } = runner;
  const SourceControlIcon = sourceControlPresentation.Icon;
  const changeRequestTerminology = sourceControlPresentation.terminology;
  // Treat the post-action status refresh as "running" so action buttons stay in
  // their loading/disabled state until the fresh status lands and the primary
  // button can flip cleanly (Commit -> Push, Push -> gone) without a stale flash.
  const isGitActionRunning = isGitActionRunningRaw || isFinalizingAction || isPushing;

  const generateCommitMessageMutation = useMutation(
    gitGenerateCommitMessageMutationOptions({ environmentId, cwd }),
  );
  // Drive the spinner from the global mutation cache so the generating state
  // survives the panel being closed/reopened (e.g. the mobile sheet).
  const isGeneratingCommitMessage =
    useIsMutating({
      mutationKey: gitMutationKeys.generateCommitMessage(environmentId, cwd),
    }) > 0;
  const stageFilesMutation = useMutation(
    vcsStageFilesMutationOptions({ environmentId, cwd, queryClient }),
  );
  const unstageFilesMutation = useMutation(
    vcsUnstageFilesMutationOptions({ environmentId, cwd, queryClient }),
  );

  const branchName = gitStatus?.refName ?? null;
  const files = useMemo(() => gitStatus?.workingTree.files ?? [], [gitStatus?.workingTree.files]);
  const hasSplitWorkingTree =
    gitStatus?.workingTree.staged !== undefined && gitStatus.workingTree.unstaged !== undefined;
  const stagedFiles = useMemo(
    () => (hasSplitWorkingTree ? (gitStatus?.workingTree.staged?.files ?? []) : []),
    [gitStatus?.workingTree.staged?.files, hasSplitWorkingTree],
  );
  const unstagedFiles = useMemo(
    () => (hasSplitWorkingTree ? (gitStatus?.workingTree.unstaged?.files ?? []) : files),
    [files, gitStatus?.workingTree.unstaged?.files, hasSplitWorkingTree],
  );
  const stagedFilePaths = useMemo(() => stagedFiles.map((file) => file.path), [stagedFiles]);
  const unstagedFilePaths = useMemo(() => unstagedFiles.map((file) => file.path), [unstagedFiles]);
  const insertions = gitStatus?.workingTree.insertions ?? 0;
  const deletions = gitStatus?.workingTree.deletions ?? 0;
  const scrollWorkspaceKey = useMemo(
    () => sourceControlPanelScrollKey({ environmentId, cwd }),
    [cwd, environmentId],
  );
  const workspaceViewState = useSourceControlPanelWorkspaceViewState(scrollWorkspaceKey);
  const viewMode = workspaceViewState.viewMode;
  const collapsedDirs = workspaceViewState.collapsedDirs;
  const scrollLayoutKey = useMemo(
    () =>
      [
        scrollWorkspaceKey,
        viewMode,
        hasSplitWorkingTree ? "split" : "combined",
        stagedFilePaths.join("\0"),
        unstagedFilePaths.join("\0"),
      ].join("\u0001"),
    [hasSplitWorkingTree, scrollWorkspaceKey, stagedFilePaths, unstagedFilePaths, viewMode],
  );

  useSourceControlScrollRestoration({
    layoutKey: scrollLayoutKey,
    rootRef: scrollRootRef,
    workspaceKey: scrollWorkspaceKey,
  });

  const buildTree = useCallback(
    (sectionFiles: typeof files): SourceControlTreeNode[] => {
      if (viewMode === "list") {
        return [...sectionFiles]
          .toSorted((a, b) => a.path.localeCompare(b.path))
          .map((file) => ({
            type: "file" as const,
            path: file.path,
            name: sourceControlFileName(file.path),
            file,
          }));
      }
      return buildSourceControlTree(sectionFiles);
    },
    [viewMode],
  );
  const stagedTree = useMemo(() => buildTree(stagedFiles), [buildTree, stagedFiles]);
  const unstagedTree = useMemo(() => buildTree(unstagedFiles), [buildTree, unstagedFiles]);

  const isStageOperationRunning = stageFilesMutation.isPending || unstageFilesMutation.isPending;
  const hasStagedFiles = stagedFiles.length > 0;
  const hasUnstagedFiles = unstagedFiles.length > 0;
  const hasChanges = hasStagedFiles || hasUnstagedFiles;

  useEffect(() => {
    if (!environmentId || !cwd) return;
    void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
  }, [environmentId, cwd]);

  const toggleDir = useCallback(
    (path: string) => {
      const next = new Set(collapsedDirs);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      recordSourceControlPanelCollapsedDirs(scrollWorkspaceKey, next);
    },
    [collapsedDirs, scrollWorkspaceKey],
  );

  const toggleSection = useCallback((section: SourceControlSection) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  const stageFiles = useCallback(
    (filePaths: ReadonlyArray<string>) => {
      if (filePaths.length === 0) return;
      const paths = [...filePaths];
      setPendingStagePaths((previous) => {
        const next = new Set(previous);
        for (const path of paths) next.add(path);
        return next;
      });
      void stageFilesMutation
        .mutateAsync({ filePaths: paths })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Unable to stage files",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        })
        .finally(() => {
          setPendingStagePaths((previous) => {
            const next = new Set(previous);
            for (const path of paths) next.delete(path);
            return next;
          });
        });
    },
    [stageFilesMutation],
  );

  const unstageFiles = useCallback(
    (filePaths: ReadonlyArray<string>) => {
      if (filePaths.length === 0) return;
      const paths = [...filePaths];
      setPendingUnstagePaths((previous) => {
        const next = new Set(previous);
        for (const path of paths) next.add(path);
        return next;
      });
      void unstageFilesMutation
        .mutateAsync({ filePaths: paths })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Unable to unstage files",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        })
        .finally(() => {
          setPendingUnstagePaths((previous) => {
            const next = new Set(previous);
            for (const path of paths) next.delete(path);
            return next;
          });
        });
    },
    [unstageFilesMutation],
  );

  const handleRefresh = useCallback(() => {
    if (!environmentId || !cwd) return;
    void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
  }, [environmentId, cwd]);

  const handleCommit = useCallback(async () => {
    // Surface progress as an inline button spinner rather than a toast.
    setIsCommitting(true);
    try {
      await runGitActionWithToast({
        action: "commit",
        ...commitMessageProps(commitMessage),
        suppressProgressToast: true,
        onSuccess: () => setCommitMessage(""),
      });
    } finally {
      setIsCommitting(false);
    }
  }, [commitMessage, runGitActionWithToast, setCommitMessage]);

  const handleCommitAndPush = useCallback(() => {
    void runGitActionWithToast({
      action: "commit_push",
      ...commitMessageProps(commitMessage),
      onSuccess: () => setCommitMessage(""),
    });
  }, [commitMessage, runGitActionWithToast, setCommitMessage]);

  const handlePush = useCallback(() => {
    void runGitActionWithToast({
      action: "push",
      toastMode: "result-only",
      onConfirmed: () => setIsPushing(true),
      onSettled: () => setIsPushing(false),
    });
  }, [runGitActionWithToast]);

  const handlePull = useCallback(() => {
    runPull();
  }, [runPull]);

  const handleCreatePullRequest = useCallback(() => {
    if (gitStatus?.pr?.state === "open") {
      void openExistingPr();
      return;
    }
    void runGitActionWithToast({ action: "create_pr" });
  }, [gitStatus?.pr?.state, openExistingPr, runGitActionWithToast]);

  const handleGenerateCommitMessage = useCallback(() => {
    void generateCommitMessageMutation
      .mutateAsync({ target: "commit" })
      .then((result) => {
        setCommitMessage(result.commitMessage);
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to generate commit message",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
  }, [generateCommitMessageMutation, setCommitMessage]);

  const handleOpenFilePreview = useCallback(
    (filePath: string) => {
      if (!environmentId || !cwd) return;
      openWorkspaceFilePreview(
        {
          environmentId,
          cwd,
          relativePath: filePath,
          displayPath: filePath,
        },
        { returnTarget: { kind: "source-control" } },
      );
    },
    [cwd, environmentId],
  );

  const handleCommitMessageKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (hasChanges && !isGitActionRunning && !isStageOperationRunning && !isCommitting) {
          void handleCommit();
        }
      }
    },
    [handleCommit, hasChanges, isCommitting, isGitActionRunning, isStageOperationRunning],
  );

  const commitDisabled =
    !isRepo || !hasChanges || isGitActionRunning || isStageOperationRunning || isCommitting;
  const aheadCount = gitStatus?.aheadCount ?? 0;
  const behindCount = gitStatus?.behindCount ?? 0;
  const isInitialStatusLoading = gitStatus === null && gitStatusError === null;
  const canPublishRepository = isRepo && gitStatus !== null && !hasPrimaryRemote;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
        terminology: changeRequestTerminology,
      })
    : null;
  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatus, isGitActionRunning, hasPrimaryRemote),
    [gitStatus, hasPrimaryRemote, isGitActionRunning],
  );
  const commitAndPushReason = commitAndPushDisabledReason({
    gitStatus,
    isGitActionRunning: isGitActionRunning || isStageOperationRunning,
    hasPrimaryRemote,
  });
  const pullReason = pullDisabledReason({ gitStatus, isGitActionRunning });
  // Once there are local commits to push, promote Push to the primary button
  // (showing ahead/behind counts like VS Code) and demote Commit into the menu.
  const pushMenuItem = gitActionMenuItems.find((item) => item.id === "push") ?? null;
  // Only promote Push once the working tree is clean, otherwise committing the
  // pending changes stays the primary action.
  const showPushPrimary = aheadCount > 0 && !hasChanges && pushMenuItem !== null;
  const pushReason = pushMenuItem
    ? getMenuActionDisabledReason({
        item: pushMenuItem,
        gitStatus,
        isBusy: isGitActionRunning || isStageOperationRunning,
        hasPrimaryRemote,
      })
    : null;
  const pushDisabled = pushMenuItem ? pushMenuItem.disabled || isStageOperationRunning : true;
  return (
    <>
      <div
        className={cn(
          "flex min-h-0 flex-col bg-card/50",
          mode === "sidebar" ? "h-full w-full border-l border-border/70" : "h-full w-full",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Source Control
          </span>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={viewMode === "tree" ? "View as list" : "View as tree"}
                    className="text-muted-foreground/60 hover:text-foreground/80"
                    onClick={() =>
                      recordSourceControlPanelViewMode(
                        scrollWorkspaceKey,
                        viewMode === "tree" ? "list" : "tree",
                      )
                    }
                  />
                }
              >
                <ListTreeIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {viewMode === "tree" ? "View as list" : "View as tree"}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Refresh"
                    className="text-muted-foreground/60 hover:text-foreground/80"
                    onClick={handleRefresh}
                  />
                }
              >
                <RefreshCwIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Refresh</TooltipPopup>
            </Tooltip>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onClose}
              aria-label="Close source control panel"
              className="text-muted-foreground/60 hover:text-foreground/80"
            >
              <PanelRightCloseIcon className="size-3.5" />
            </Button>
          </div>
        </div>

        {!cwd ? (
          <div className="border-b border-border/50 p-3 text-xs text-muted-foreground">
            Source control is unavailable until this thread has an active project.
          </div>
        ) : !isRepo ? (
          <div className="space-y-3 border-b border-border/50 p-3">
            <p className="text-xs text-muted-foreground">This project is not a git repository.</p>
            <Button
              size="sm"
              variant="outline"
              disabled={initMutation.isPending}
              onClick={() => initMutation.mutate()}
            >
              <SourceControlIcon className="size-3.5" />
              {initMutation.isPending ? "Initializing..." : "Initialize Git"}
            </Button>
            {gitStatusError ? (
              <p className="text-xs text-destructive">{gitStatusError.message}</p>
            ) : null}
          </div>
        ) : (
          <div className="shrink-0 space-y-2 border-b border-border/50 p-3">
            <div className="relative">
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                onKeyDown={handleCommitMessageKeyDown}
                size="sm"
                className="[&_[data-slot=textarea]]:pr-10"
                placeholder={
                  branchName
                    ? `Message (Ctrl+Enter to commit on "${branchName}") - leave blank to auto-generate`
                    : "Message - leave blank to auto-generate"
                }
                aria-label="Commit message"
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Generate commit message"
                      className="absolute right-1.5 top-1.5 text-muted-foreground/70 hover:text-foreground"
                      disabled={
                        isGeneratingCommitMessage ||
                        !hasChanges ||
                        isGitActionRunning ||
                        isStageOperationRunning
                      }
                      onClick={handleGenerateCommitMessage}
                    />
                  }
                >
                  {isGeneratingCommitMessage ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <SparklesIcon className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="left">Generate commit message</TooltipPopup>
              </Tooltip>
            </div>
            <div className="flex items-stretch">
              {showPushPrimary ? (
                <Button
                  size="sm"
                  className="flex-1 rounded-e-none"
                  disabled={pushDisabled}
                  title={pushReason ?? undefined}
                  onClick={handlePush}
                >
                  {isPushing ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <CloudUploadIcon className="size-3.5" />
                  )}
                  Push
                  {!isPushing ? (
                    <span className="flex items-center gap-2 text-[11px] tabular-nums">
                      <span className="flex items-center gap-0.5">
                        <ArrowUpIcon className="size-3" />
                        {aheadCount}
                      </span>
                      {behindCount > 0 ? (
                        <span className="flex items-center gap-0.5">
                          <ArrowDownIcon className="size-3" />
                          {behindCount}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="flex-1 rounded-e-none"
                  disabled={commitDisabled}
                  onClick={() => void handleCommit()}
                >
                  {isCommitting ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <CheckIcon className="size-3.5" />
                  )}
                  Commit
                </Button>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="sm"
                      aria-label="More commit actions"
                      disabled={isGitActionRunning || isStageOperationRunning}
                      className="rounded-s-none border-s border-primary-foreground/20 px-1.5"
                    />
                  }
                >
                  <ChevronDownIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-56">
                  {gitActionMenuItems.map((item) => (
                    <SourceControlMenuItem
                      key={`${item.id}-${item.label}`}
                      item={item}
                      disabledReason={getMenuActionDisabledReason({
                        item,
                        gitStatus,
                        isBusy: isGitActionRunning || isStageOperationRunning,
                        hasPrimaryRemote,
                      })}
                      onSelect={() => {
                        if (item.id === "commit") {
                          void handleCommit();
                        } else if (item.id === "push") {
                          handlePush();
                        } else {
                          handleCreatePullRequest();
                        }
                      }}
                    />
                  ))}
                  <MenuItem
                    disabled={commitAndPushReason !== null}
                    title={commitAndPushReason ?? undefined}
                    onClick={handleCommitAndPush}
                  >
                    <CloudUploadIcon className="size-4" />
                    Commit &amp; Push
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    disabled={pullReason !== null}
                    title={pullReason ?? undefined}
                    onClick={handlePull}
                  >
                    <RefreshCwIcon className="size-4" />
                    Pull
                  </MenuItem>
                  {canPublishRepository ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        disabled={isGitActionRunning}
                        onClick={() => setIsPublishDialogOpen(true)}
                      >
                        <CloudUploadIcon className="size-4" />
                        Publish repository...
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
            <div className="space-y-1">
              {branchName ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                  <GitBranchIcon className="size-3" />
                  <span className="truncate">{branchName}</span>
                  {isDefaultRef ? <span className="text-warning">default refName</span> : null}
                </div>
              ) : isInitialStatusLoading ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                  <Spinner className="size-3" />
                  <span>Loading source control…</span>
                </div>
              ) : (
                <p className="text-[11px] text-warning">
                  Detached HEAD: create and checkout a refName to enable push and pull request
                  actions.
                </p>
              )}
              {canPublishRepository ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={isGitActionRunning}
                  onClick={() => setIsPublishDialogOpen(true)}
                >
                  <CloudUploadIcon className="size-3.5" />
                  Publish repository
                </Button>
              ) : null}
              {gitStatus &&
              gitStatus.refName !== null &&
              !gitStatus.hasWorkingTreeChanges &&
              gitStatus.behindCount > 0 &&
              gitStatus.aheadCount === 0 ? (
                <p className="text-[11px] text-warning">Behind upstream. Pull/rebase first.</p>
              ) : null}
              {gitStatusError ? (
                <p className="text-[11px] text-destructive">{gitStatusError.message}</p>
              ) : null}
            </div>
          </div>
        )}

        <div ref={scrollRootRef} className="min-h-0 flex-1">
          <ScrollArea className="h-full min-h-0" data-testid="source-control-scroll">
            <div className="p-1.5">
              {hasChanges ? (
                <div className="space-y-0.5">
                  <SourceControlSectionTree
                    section="staged"
                    label="Staged Changes"
                    tree={stagedTree}
                    viewMode={viewMode}
                    fileCount={stagedFiles.length}
                    filePaths={stagedFilePaths}
                    collapsed={collapsedSections.has("staged")}
                    collapsedDirs={collapsedDirs}
                    resolvedTheme={resolvedTheme}
                    actionDisabled={isGitActionRunning || isStageOperationRunning}
                    pendingPaths={pendingUnstagePaths}
                    onToggleSection={toggleSection}
                    onToggleDir={toggleDir}
                    onSectionAction={unstageFiles}
                    onFileAction={(path) => unstageFiles([path])}
                    onOpenFilePreview={handleOpenFilePreview}
                  />
                  <SourceControlSectionTree
                    section="unstaged"
                    label="Changes"
                    tree={unstagedTree}
                    viewMode={viewMode}
                    fileCount={unstagedFiles.length}
                    filePaths={unstagedFilePaths}
                    collapsed={collapsedSections.has("unstaged")}
                    collapsedDirs={collapsedDirs}
                    resolvedTheme={resolvedTheme}
                    actionDisabled={isGitActionRunning || isStageOperationRunning}
                    pendingPaths={pendingStagePaths}
                    onToggleSection={toggleSection}
                    onToggleDir={toggleDir}
                    onSectionAction={stageFiles}
                    onFileAction={(path) => stageFiles([path])}
                    onOpenFilePreview={handleOpenFilePreview}
                  />
                </div>
              ) : (
                <p className="px-1.5 py-6 text-center text-xs text-muted-foreground/60">
                  No changes detected.
                </p>
              )}
            </div>
          </ScrollArea>
        </div>

        {hasChanges ? (
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/50 px-3 py-1.5 font-mono text-[11px]">
            <span className="text-muted-foreground">
              {stagedFiles.length} staged / {unstagedFiles.length} unstaged
            </span>
            <span className="flex items-center gap-2">
              <span className="text-emerald-500">+{insertions}</span>
              <span className="text-muted-foreground/50">/</span>
              <span className="text-destructive">-{deletions}</span>
            </span>
          </div>
        ) : null}
      </div>

      {cwd ? (
        <SourceControlPublishDialog
          open={isPublishDialogOpen}
          onOpenChange={setIsPublishDialogOpen}
          environmentId={environmentId}
          gitCwd={cwd}
        />
      ) : null}

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default refName?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              Abort
            </Button>
            <Button
              className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
              variant="outline"
              size="sm"
              onClick={continuePendingDefaultBranchAction}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            <Button
              className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
              size="sm"
              onClick={checkoutFeatureBranchAndContinuePendingAction}
            >
              Checkout feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function SourceControlMenuItem({
  item,
  disabledReason,
  onSelect,
}: {
  item: GitActionMenuItem;
  disabledReason: string | null;
  onSelect: () => void;
}) {
  const Icon =
    item.id === "commit"
      ? GitCommitIcon
      : item.id === "push"
        ? CloudUploadIcon
        : GitPullRequestArrowIcon;
  return (
    <MenuItem
      disabled={disabledReason !== null}
      title={disabledReason ?? undefined}
      onClick={onSelect}
    >
      <Icon className="size-4" />
      {item.label}
    </MenuItem>
  );
}

function SourceControlSectionTree({
  section,
  label,
  tree,
  viewMode,
  fileCount,
  filePaths,
  collapsed,
  collapsedDirs,
  resolvedTheme,
  actionDisabled,
  pendingPaths,
  onToggleSection,
  onToggleDir,
  onSectionAction,
  onFileAction,
  onOpenFilePreview,
}: {
  section: SourceControlSection;
  label: string;
  tree: ReadonlyArray<SourceControlTreeNode>;
  viewMode: "tree" | "list";
  fileCount: number;
  filePaths: ReadonlyArray<string>;
  collapsed: boolean;
  collapsedDirs: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  actionDisabled: boolean;
  pendingPaths: ReadonlySet<string>;
  onToggleSection: (section: SourceControlSection) => void;
  onToggleDir: (path: string) => void;
  onSectionAction: (paths: ReadonlyArray<string>) => void;
  onFileAction: (path: string) => void;
  onOpenFilePreview: (path: string) => void;
}) {
  const ActionIcon = section === "staged" ? MinusIcon : PlusIcon;
  const actionLabel = section === "staged" ? "Unstage all" : "Stage all";
  const sectionActionPending = filePaths.some((path) => pendingPaths.has(path));

  return (
    <section>
      <div className="group/section flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => onToggleSection(section)}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          )}
          <span className="truncate uppercase tracking-wide">{label}</span>
          <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
            {fileCount}
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={actionLabel}
                disabled={actionDisabled || fileCount === 0}
                className="text-muted-foreground/70 hover:text-foreground"
                onClick={() => onSectionAction(filePaths)}
              />
            }
          >
            {sectionActionPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <ActionIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="left">{actionLabel}</TooltipPopup>
        </Tooltip>
      </div>
      {collapsed || fileCount === 0 ? null : (
        <div className="pl-3">
          {tree.map((node) => (
            <SourceControlTreeRow
              key={node.path}
              node={node}
              section={section}
              viewMode={viewMode}
              depth={0}
              collapsedDirs={collapsedDirs}
              resolvedTheme={resolvedTheme}
              actionDisabled={actionDisabled}
              pendingPaths={pendingPaths}
              onToggleDir={onToggleDir}
              onFileAction={onFileAction}
              onOpenFilePreview={onOpenFilePreview}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SourceControlTreeRow({
  node,
  section,
  viewMode,
  depth,
  collapsedDirs,
  resolvedTheme,
  actionDisabled,
  pendingPaths,
  onToggleDir,
  onFileAction,
  onOpenFilePreview,
}: {
  node: SourceControlTreeNode;
  section: SourceControlSection;
  viewMode: "tree" | "list";
  depth: number;
  collapsedDirs: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  actionDisabled: boolean;
  pendingPaths: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onFileAction: (path: string) => void;
  onOpenFilePreview: (path: string) => void;
}) {
  const indentStyle = { paddingLeft: `${depth * 12 + 6}px` };

  if (node.type === "dir") {
    const collapseKey = `${section}:${node.path}`;
    const collapsed = collapsedDirs.has(collapseKey);
    return (
      <>
        <div
          style={indentStyle}
          className="flex w-full items-center gap-1 rounded-md py-0.5 pr-2 text-left text-[13px] text-foreground/90 transition-colors hover:bg-accent/50"
        >
          <button
            type="button"
            onClick={() => onToggleDir(collapseKey)}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            {collapsed ? (
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
            ) : (
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
            )}
            <VscodeEntryIcon
              pathValue={node.path}
              kind="directory"
              theme={resolvedTheme}
              className="size-4 shrink-0"
            />
            <span className="truncate">{node.name}</span>
          </button>
        </div>
        {collapsed
          ? null
          : node.children.map((child) => (
              <SourceControlTreeRow
                key={child.path}
                node={child}
                section={section}
                viewMode={viewMode}
                depth={depth + 1}
                collapsedDirs={collapsedDirs}
                resolvedTheme={resolvedTheme}
                actionDisabled={actionDisabled}
                pendingPaths={pendingPaths}
                onToggleDir={onToggleDir}
                onFileAction={onFileAction}
                onOpenFilePreview={onOpenFilePreview}
              />
            ))}
      </>
    );
  }

  const badge = statusBadge(node.file.status);
  const ActionIcon = section === "staged" ? MinusIcon : PlusIcon;
  const actionLabel = section === "staged" ? `Unstage ${node.path}` : `Stage ${node.path}`;
  const filePending = pendingPaths.has(node.path);
  return (
    <div
      style={indentStyle}
      title={node.path}
      className="group flex w-full items-center gap-1.5 rounded-md py-0.5 pr-2 text-left transition-colors hover:bg-accent/50"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={() => onOpenFilePreview(node.path)}
      >
        {/* Spacer matching the directory chevron so file icons align with sibling folder icons. */}
        {viewMode === "tree" ? <span className="size-3.5 shrink-0" aria-hidden="true" /> : null}
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{node.name}</span>
        <span
          className={cn("shrink-0 text-[11px] font-semibold tabular-nums", badge.className)}
          aria-label={badge.label}
          title={badge.label}
        >
          {badge.letter}
        </span>
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={actionLabel}
              disabled={actionDisabled}
              className="shrink-0 text-muted-foreground/70 hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onFileAction(node.path);
              }}
            />
          }
        >
          {filePending ? <Spinner className="size-3.5" /> : <ActionIcon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup side="left">
          {section === "staged" ? "Unstage file" : "Stage file"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
