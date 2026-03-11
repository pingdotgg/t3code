import type { GitMergeBranchesResult, ThreadId } from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CloudUploadIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { GitHubIcon } from "../Icons";
import {
  buildMenuItems,
  type GitActionMenuItem,
  resolveDefaultBranchActionDialogCopy,
} from "../GitActionsControl.logic";
import { deriveWorkspaceStatusInfo, resolveDefaultMergeSourceBranch } from "./GitPanel.logic";
import { resolveEffectiveEnvMode } from "../BranchToolbar.logic";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import {
  githubIssuesQueryOptions,
  githubLoginMutationOptions,
  githubStatusQueryOptions,
  invalidateGitHubQueries,
} from "~/lib/githubReactQuery";
import {
  gitAbortMergeMutationOptions,
  gitBranchesQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitInitMutationOptions,
  gitMergeBranchesMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRemoveWorktreeMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { preferredTerminalEditor, resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useStore } from "~/store";
import { GitHubAuthSection } from "./GitHubAuthSection";
import { GitHubIssuesSection } from "./GitHubIssuesSection";
import { GitSyncSection } from "./GitSyncSection";
import { GitStatusDot } from "./GitStatusDot";
import { GitWorkspaceSection } from "./GitWorkspaceSection";
import { GitCommitDialog } from "./GitCommitDialog";
import { GitDefaultBranchDialog } from "./GitDefaultBranchDialog";
import { GitPromoteDialog } from "./GitPromoteDialog";
import { useGitPanelGitHubActions } from "./useGitPanelGitHubActions";
import { useGitPanelMergeActions } from "./useGitPanelMergeActions";
import {
  type PendingDefaultBranchAction,
  useGitPanelStackedActions,
} from "./useGitPanelStackedActions";
import { useGitPanelThreadRouting } from "./useGitPanelThreadRouting";
import { useGitPanelWorkspaceActions } from "./useGitPanelWorkspaceActions";

interface GitPanelProps {
  workspaceCwd: string | null;
  repoCwd: string | null;
  repoRoot: string | null;
  activeThreadId: ThreadId | null;
}

// =============================================================================
// Keyboard Shortcut Hint
// =============================================================================

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border/50 bg-muted/50 px-1 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export default function GitPanel({
  workspaceCwd,
  repoCwd,
  repoRoot,
  activeThreadId,
}: GitPanelProps) {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const activeServerThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads],
  );
  const activeDraftThread = useComposerDraftStore((store) =>
    activeThreadId ? store.getDraftThread(activeThreadId) : null,
  );
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const activeProjectId = activeServerThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const hasServerThread = activeServerThread !== null;
  const activeThreadBranch = activeServerThread?.branch ?? activeDraftThread?.branch ?? null;
  const activeWorktreePath =
    activeServerThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: activeDraftThread?.envMode,
  });
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [issueState, setIssueState] = useState<"open" | "closed" | "all">("open");
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [mergeSourceBranch, setMergeSourceBranch] = useState("");
  const [lastMergeResult, setLastMergeResult] = useState<GitMergeBranchesResult | null>(null);
  const [mergeExpanded] = useState(false);
  const [promotionTargetBranch] = useState<string | null>(null);
  const [isPromoteDialogOpen, setIsPromoteDialogOpen] = useState(false);
  const primaryWorkspaceStatusCwd =
    workspaceCwd !== null && repoRoot !== null && workspaceCwd !== repoRoot ? repoRoot : null;

  const { data: gitStatus = null, error: gitStatusError } = useQuery(
    gitStatusQueryOptions(workspaceCwd),
  );
  const { data: primaryWorkspaceStatus = null, error: primaryWorkspaceStatusError } = useQuery(
    gitStatusQueryOptions(primaryWorkspaceStatusCwd),
  );

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(workspaceCwd));
  const githubStatusQuery = useQuery(githubStatusQueryOptions(repoCwd));
  const isRepo = branchList?.isRepo ?? true;
  const currentBranch = branchList?.branches.find((branch) => branch.current)?.name ?? null;
  const isGitStatusOutOfSync =
    !!gitStatus?.branch && !!currentBranch && gitStatus.branch !== currentBranch;

  useEffect(() => {
    if (!isGitStatusOutOfSync) return;
    void invalidateGitQueries(queryClient);
  }, [isGitStatusOutOfSync, queryClient]);

  const gitStatusForActions = isGitStatusOutOfSync ? null : gitStatus;

  const initMutation = useMutation(gitInitMutationOptions({ cwd: workspaceCwd, queryClient }));
  const loginMutation = useMutation(githubLoginMutationOptions({ cwd: repoCwd, queryClient }));
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));

  const githubIssuesQuery = useQuery(
    githubIssuesQueryOptions({
      cwd: repoCwd,
      state: issueState,
      limit: 10,
      enabled:
        githubStatusQuery.data?.installed === true &&
        githubStatusQuery.data?.authenticated === true &&
        githubStatusQuery.data?.repo !== null,
    }),
  );
  const isGitHubAuthenticated = githubStatusQuery.data?.authenticated === true;

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({ cwd: workspaceCwd, queryClient }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: workspaceCwd, queryClient }));
  const mergeBranchesMutation = useMutation(
    gitMergeBranchesMutationOptions({ cwd: workspaceCwd, queryClient }),
  );
  const abortMergeMutation = useMutation(
    gitAbortMergeMutationOptions({ cwd: workspaceCwd, queryClient }),
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(workspaceCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(workspaceCwd) }) > 0;
  const isMergeRunning =
    useIsMutating({ mutationKey: gitMutationKeys.mergeBranches(workspaceCwd) }) > 0;
  const isAbortMergeRunning =
    useIsMutating({ mutationKey: gitMutationKeys.abortMerge(workspaceCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const localBranches = useMemo(
    () => (branchList?.branches ?? []).filter((branch) => !branch.isRemote),
    [branchList?.branches],
  );
  const defaultBranch = useMemo(
    () => localBranches.find((branch) => branch.isDefault)?.name ?? null,
    [localBranches],
  );
  const activeWorkspaceBranch = gitStatusForActions?.branch ?? currentBranch;
  const activeWorkspaceBranchMeta = useMemo(
    () => localBranches.find((branch) => branch.name === activeWorkspaceBranch) ?? null,
    [activeWorkspaceBranch, localBranches],
  );
  const isPrimaryWorkspace = repoRoot !== null && workspaceCwd === repoRoot;
  const activeWorkspaceMerge =
    gitStatusForActions?.merge ?? ({ inProgress: false, conflictedFiles: [] } as const);
  const activeWorkspaceHasConflicts = activeWorkspaceMerge.conflictedFiles.length > 0;
  const isDefaultBranch = useMemo(() => {
    const branchName = gitStatusForActions?.branch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [branchList?.branches, gitStatusForActions?.branch]);
  const detectedTargetBranch = gitStatusForActions?.pr?.baseBranch ?? defaultBranch;
  // User can override the promotion target; fall back to detected
  const activeTargetBranch = promotionTargetBranch ?? detectedTargetBranch;
  const statusInfo = useMemo(
    () =>
      deriveWorkspaceStatusInfo({
        hasConflicts: activeWorkspaceHasConflicts,
        mergeInProgress: activeWorkspaceMerge.inProgress,
        hasChanges: gitStatusForActions?.hasWorkingTreeChanges ?? false,
      }),
    [
      activeWorkspaceHasConflicts,
      activeWorkspaceMerge.inProgress,
      gitStatusForActions?.hasWorkingTreeChanges,
    ],
  );

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning),
    [gitStatusForActions, isGitActionRunning],
  );
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
      })
    : null;

  useEffect(() => {
    const branchNames = localBranches.map((branch) => branch.name);
    const nextSourceBranch = resolveDefaultMergeSourceBranch({
      branchNames,
      activeWorkspaceBranch,
      activeTargetBranch,
      currentMergeSourceBranch: mergeSourceBranch,
    });
    if (nextSourceBranch !== mergeSourceBranch) {
      setMergeSourceBranch(nextSourceBranch);
    }
  }, [activeTargetBranch, activeWorkspaceBranch, localBranches, mergeSourceBranch]);

  useEffect(() => {
    if (
      lastMergeResult &&
      (lastMergeResult.targetWorktreePath !== workspaceCwd ||
        lastMergeResult.targetBranch !== activeWorkspaceBranch)
    ) {
      setLastMergeResult(null);
    }
  }, [activeWorkspaceBranch, lastMergeResult, workspaceCwd]);

  const openPathInEditor = useCallback(
    (targetPath: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Editor unavailable",
          data: threadToastData,
        });
        return;
      }
      void api.shell.openInEditor(targetPath, preferredTerminalEditor()).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to open",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [threadToastData],
  );

  const navigateToThread = useCallback(
    async (threadId: ThreadId) => {
      if (threadId !== activeThreadId) {
        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      }
    },
    [activeThreadId, navigate],
  );
  const { focusDraftThread, focusPrimaryWorkspaceDraft, persistThreadWorkspaceContext } =
    useGitPanelThreadRouting({
      activeDraftThreadProjectId: activeDraftThread?.projectId ?? null,
      activeDraftThreadWorktreePath: activeDraftThread?.worktreePath ?? null,
      activeProjectId,
      activeServerThread: activeServerThread !== null,
      activeThreadId,
      activeThreadBranch,
      activeWorkspaceBranch,
      activeWorktreePath,
      effectiveEnvMode,
      getDraftThreadByProjectId,
      hasServerThread,
      navigateToThread,
      setDraftThreadContext,
      setProjectDraftThreadId,
      setThreadBranchAction,
    });
  const invalidateQueries = useCallback(async () => {
    await invalidateGitQueries(queryClient);
  }, [queryClient]);
  const { createDedicatedWorkspace, closeDedicatedWorkspace, openPrimaryWorkspaceResolutionDraft } =
    useGitPanelWorkspaceActions({
      activeServerThreadSessionStatus: activeServerThread?.session?.status ?? null,
      activeThreadBranch,
      activeThreadId,
      activeWorkspaceBranch,
      focusDraftThread,
      focusPrimaryWorkspaceDraft,
      invalidateQueries,
      isPrimaryWorkspace,
      persistThreadWorkspaceContext,
      primaryWorkspaceStatus,
      repoCwd,
      repoRoot,
      removeWorktree: removeWorktreeMutation.mutateAsync,
      repoWorkspaceCwd: workspaceCwd,
      createWorktree: createWorktreeMutation.mutateAsync,
      setPrompt,
      threadToastData,
    });
  const { runMergeFromBranch, runLocalMerge, abortActiveMerge, createResolveConflictDraft } =
    useGitPanelMergeActions({
      activeTargetBranch,
      activeThreadId,
      activeWorkspaceBranch,
      conflictedFiles: activeWorkspaceMerge.conflictedFiles,
      lastMergeResult,
      mergeSourceBranch,
      mergeBranches: mergeBranchesMutation.mutateAsync,
      abortMerge: abortMergeMutation.mutateAsync,
      setLastMergeResult,
      setPrompt,
      threadToastData,
      workspaceCwd,
    });

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link unavailable",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err) => {
      toastManager.add({
        type: "error",
        title: "Failed to open PR",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      });
    });
  }, [gitStatusForActions?.pr?.state, gitStatusForActions?.pr?.url, threadToastData]);

  const {
    runGitActionWithToast,
    continuePendingDefaultBranchAction,
    checkoutNewBranchAndRunAction,
    checkoutFeatureBranchAndContinuePendingAction,
  } = useGitPanelStackedActions({
    gitStatusForActions,
    isDefaultBranch,
    pendingDefaultBranchAction,
    runImmediateGitAction: runImmediateGitActionMutation.mutateAsync,
    setPendingDefaultBranchAction,
    threadToastData,
  });

  const runDialogActionOnNewBranch = useCallback(
    (commitMessage: string) => {
      if (!isCommitDialogOpen) return;

      setIsCommitDialogOpen(false);

      checkoutNewBranchAndRunAction({
        action: "commit",
        ...(commitMessage ? { commitMessage } : {}),
      });
    },
    [checkoutNewBranchAndRunAction, isCommitDialogOpen],
  );

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
      if (item.dialogAction === "create_pr") {
        void runGitActionWithToast({ action: "commit_push_pr" });
        return;
      }
      setIsCommitDialogOpen(true);
    },
    [openExistingPr, runGitActionWithToast, setIsCommitDialogOpen],
  );

  const runPromoteAction = useCallback(() => {
    if (!activeTargetBranch) return;
    setIsPromoteDialogOpen(false);
    void runGitActionWithToast({
      action: "promote",
      targetBranch: activeTargetBranch,
    });
  }, [activeTargetBranch, runGitActionWithToast]);

  const runDialogAction = useCallback(
    (commitMessage: string) => {
      if (!isCommitDialogOpen) return;

      setIsCommitDialogOpen(false);
      void runGitActionWithToast({
        action: "commit",
        ...(commitMessage ? { commitMessage } : {}),
      });
    },
    [isCommitDialogOpen, runGitActionWithToast],
  );

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!workspaceCwd) {
        toastManager.add({
          type: "error",
          title: "Editor unavailable",
          data: threadToastData,
        });
        return;
      }
      openPathInEditor(resolvePathLinkTarget(filePath, workspaceCwd));
    },
    [openPathInEditor, threadToastData, workspaceCwd],
  );

  const pullLatest = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Pulling...", data: threadToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Up to date",
        description:
          result.status === "pulled"
            ? `Updated from ${result.upstreamBranch ?? "upstream"}`
            : undefined,
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Pull failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [pullMutation, threadToastData]);

  const commitItem = gitActionMenuItems.find((item) => item.id === "commit") ?? null;
  const prItem = gitActionMenuItems.find((item) => item.id === "pr") ?? null;
  const githubRepoUrl = githubStatusQuery.data?.repo?.url ?? null;
  const { issuesDisabled, openExternalUrl, runAuthAction } = useGitPanelGitHubActions({
    isGitHubAuthenticated,
    githubRepoUrl,
    issuesErrorMessage: githubIssuesQuery.error?.message ?? null,
    login: () => loginMutation.mutate(),
    refetchStatus: async () => {
      const result = await githubStatusQuery.refetch();
      return {
        data: result.data,
        error: result.error ?? null,
      };
    },
    threadToastData,
  });
  const pullEnabled =
    !!gitStatusForActions &&
    gitStatusForActions.branch !== null &&
    !gitStatusForActions.hasWorkingTreeChanges &&
    gitStatusForActions.behindCount > 0 &&
    !isGitActionRunning;
  const commitPushAvailable =
    !!gitStatusForActions &&
    gitStatusForActions.branch !== null &&
    !isGitActionRunning &&
    (gitStatusForActions.hasWorkingTreeChanges || gitStatusForActions.aheadCount > 0);
  const commitPushDisabledReason = !gitStatusForActions
    ? "Status unavailable"
    : gitStatusForActions.branch === null
      ? "Detached HEAD"
      : isGitActionRunning
        ? "Action in progress"
        : !(gitStatusForActions.hasWorkingTreeChanges || gitStatusForActions.aheadCount > 0)
          ? "Nothing to push"
          : null;
  if (!workspaceCwd) return null;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <GitHubIcon className="size-4" />
            <span className="text-sm font-medium">Git</span>
            {githubStatusQuery.data?.repo?.nameWithOwner && (
              <span className="text-xs text-muted-foreground">
                {githubStatusQuery.data.repo.nameWithOwner}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {githubStatusQuery.data?.authenticated ? (
              <Badge variant="success" size="sm">
                <GitStatusDot level="success" className="mr-0.5" />
                gh
              </Badge>
            ) : githubStatusQuery.data?.installed ? (
              <Badge variant="warning" size="sm">
                Auth needed
              </Badge>
            ) : (
              <Badge variant="outline" size="sm">
                No gh
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                void invalidateGitQueries(queryClient);
                void invalidateGitHubQueries(queryClient);
              }}
              aria-label="Refresh"
            >
              <RefreshCcwIcon
                className={cn(
                  "size-3.5",
                  (githubStatusQuery.isFetching || githubIssuesQuery.isFetching) && "animate-spin",
                )}
              />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 p-4">
            {/* ============================================================ */}
            {/* PRIMARY ACTION ZONE - Only for primary workspace */}
            {/* ============================================================ */}
            {!isRepo ? (
              <Button
                variant="default"
                size="sm"
                disabled={initMutation.isPending}
                onClick={() => initMutation.mutate()}
                className="w-full"
              >
                {initMutation.isPending ? "Initializing..." : "Initialize Git"}
              </Button>
            ) : isPrimaryWorkspace ? (
              <div className="space-y-2">
                <Button
                  variant="default"
                  size="default"
                  disabled={!commitPushAvailable}
                  onClick={() => {
                    void runGitActionWithToast({ action: "commit_push" });
                  }}
                  className="w-full justify-between"
                >
                  <span className="flex items-center gap-2">
                    <CloudUploadIcon className="size-4" />
                    Commit &amp; Push
                  </span>
                  <Kbd>⌘⇧P</Kbd>
                </Button>

                {commitPushDisabledReason && (
                  <p className="text-center text-xs text-muted-foreground">
                    {commitPushDisabledReason}
                  </p>
                )}

                {/* Secondary actions row */}
                <div className="grid grid-cols-4 gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!commitItem || commitItem.disabled}
                    onClick={() => {
                      if (commitItem) openDialogForMenuItem(commitItem);
                    }}
                    className="justify-center"
                  >
                    <GitCommitIcon className="size-3.5" />
                    Commit
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!pullEnabled}
                    onClick={pullLatest}
                    className="justify-center"
                  >
                    <RefreshCcwIcon className="size-3.5" />
                    Pull
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={
                      !activeTargetBranch ||
                      isDefaultBranch ||
                      isGitActionRunning ||
                      !gitStatusForActions ||
                      activeWorkspaceHasConflicts
                    }
                    onClick={() => setIsPromoteDialogOpen(true)}
                    className="justify-center"
                  >
                    <GitMergeIcon className="size-3.5" />
                    Promote
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!prItem || prItem.disabled}
                    onClick={() => {
                      if (prItem) openDialogForMenuItem(prItem);
                    }}
                    className="justify-center"
                  >
                    <GitPullRequestIcon className="size-3.5" />
                    {prItem?.kind === "open_pr" ? "View PR" : "PR"}
                  </Button>
                </div>

                {/* Status hints */}
                {gitStatusForActions?.branch === null && (
                  <p className="text-center text-xs text-warning-foreground">
                    Detached HEAD — checkout a branch
                  </p>
                )}
                {isGitStatusOutOfSync && (
                  <p className="text-center text-xs text-muted-foreground">Syncing...</p>
                )}
                {gitStatusError && (
                  <p className="text-center text-xs text-destructive-foreground">
                    {gitStatusError.message}
                  </p>
                )}
              </div>
            ) : null}

            {/* ============================================================ */}
            {/* WORKSPACE SECTION */}
            {/* ============================================================ */}
            {isRepo && (
              <GitWorkspaceSection
                workspaceCwd={workspaceCwd}
                repoCwd={repoCwd}
                activeProjectId={activeProjectId}
                activeThreadId={activeThreadId}
                activeThreadBranch={activeThreadBranch}
                activeWorkspaceBranch={activeWorkspaceBranch}
                activeWorkspaceBranchMeta={activeWorkspaceBranchMeta}
                activeTargetBranch={activeTargetBranch}
                gitStatus={gitStatusForActions}
                primaryWorkspaceStatus={primaryWorkspaceStatus}
                primaryWorkspaceStatusErrorMessage={primaryWorkspaceStatusError?.message ?? null}
                isPrimaryWorkspace={isPrimaryWorkspace}
                hasConflicts={activeWorkspaceHasConflicts}
                mergeInProgress={activeWorkspaceMerge.inProgress}
                isGitActionRunning={isGitActionRunning}
                isMerging={isMergeRunning}
                isCreatingWorktree={createWorktreeMutation.isPending}
                isRemovingWorktree={removeWorktreeMutation.isPending}
                statusInfo={statusInfo}
                onOpenWorkspace={() => openPathInEditor(workspaceCwd)}
                onCreateDedicatedWorkspace={createDedicatedWorkspace}
                onOpenCommitDialog={() => {
                  if (commitItem) {
                    openDialogForMenuItem(commitItem);
                  }
                }}
                onSyncFromTarget={() => {
                  if (activeTargetBranch) {
                    void runMergeFromBranch(activeTargetBranch);
                  }
                }}
                onCloseWorkspace={() => closeDedicatedWorkspace(false)}
                onDiscardAndCloseWorkspace={() => closeDedicatedWorkspace(true)}
                onPreparePrimaryCheckout={openPrimaryWorkspaceResolutionDraft}
              />
            )}

            {/* ============================================================ */}
            {/* SYNC SECTION - Pull changes INTO this workspace */}
            {/* ============================================================ */}
            {isRepo && localBranches.length > 1 && (
              <GitSyncSection
                localBranches={localBranches}
                activeWorkspaceBranch={activeWorkspaceBranch}
                mergeSourceBranch={mergeSourceBranch}
                onMergeSourceBranchChange={setMergeSourceBranch}
                gitStatus={gitStatusForActions}
                mergeState={activeWorkspaceMerge}
                hasConflicts={activeWorkspaceHasConflicts}
                isMergeRunning={isMergeRunning}
                isAbortMergeRunning={isAbortMergeRunning}
                activeThreadId={activeThreadId}
                lastMergeResult={lastMergeResult}
                defaultOpen={mergeExpanded}
                onRunLocalMerge={runLocalMerge}
                onCreateResolveConflictDraft={createResolveConflictDraft}
                onAbortActiveMerge={abortActiveMerge}
              />
            )}

            {/* ============================================================ */}
            {/* GITHUB AUTH SECTION */}
            {/* ============================================================ */}
            <GitHubAuthSection
              accountLogin={githubStatusQuery.data?.accountLogin ?? null}
              installed={githubStatusQuery.data?.installed === true}
              authenticated={isGitHubAuthenticated}
              isFetching={githubStatusQuery.isFetching}
              isAuthenticating={loginMutation.isPending}
              githubRepoUrl={githubRepoUrl}
              errorMessage={loginMutation.error?.message ?? null}
              onAuthAction={runAuthAction}
              onOpenRepo={() => {
                if (githubRepoUrl) {
                  void openExternalUrl(githubRepoUrl);
                }
              }}
            />

            {/* ============================================================ */}
            {/* ISSUES SECTION */}
            {/* ============================================================ */}
            <GitHubIssuesSection
              visible={
                githubStatusQuery.data?.authenticated === true &&
                githubStatusQuery.data?.repo !== null
              }
              issueState={issueState}
              onIssueStateChange={setIssueState}
              isLoading={githubIssuesQuery.isLoading}
              isFetching={githubIssuesQuery.isFetching}
              issuesDisabled={issuesDisabled}
              errorMessage={githubIssuesQuery.error?.message ?? null}
              issues={githubIssuesQuery.data?.issues ?? []}
              onOpenIssue={(url) => {
                void openExternalUrl(url);
              }}
            />
          </div>
        </ScrollArea>
      </div>

      <GitCommitDialog
        open={isCommitDialogOpen}
        branchName={gitStatusForActions?.branch ?? null}
        isDefaultBranch={isDefaultBranch}
        workingTree={gitStatusForActions?.workingTree ?? null}
        onOpenChange={setIsCommitDialogOpen}
        onOpenFile={openChangedFileInEditor}
        onSubmit={runDialogAction}
        onSubmitNewBranch={runDialogActionOnNewBranch}
      />

      <GitDefaultBranchDialog
        open={pendingDefaultBranchAction !== null}
        copy={pendingDefaultBranchActionCopy}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
        onContinue={continuePendingDefaultBranchAction}
        onCreateBranch={checkoutFeatureBranchAndContinuePendingAction}
      />

      <GitPromoteDialog
        open={isPromoteDialogOpen}
        sourceBranch={activeWorkspaceBranch}
        targetBranch={activeTargetBranch}
        hasWorkingTreeChanges={gitStatusForActions?.hasWorkingTreeChanges ?? false}
        onOpenChange={setIsPromoteDialogOpen}
        onPromote={runPromoteAction}
      />
    </>
  );
}
