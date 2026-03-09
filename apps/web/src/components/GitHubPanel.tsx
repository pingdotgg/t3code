import type {
  GitMergeBranchesResult,
  GitStackedAction,
  GitStatusResult,
  ThreadId,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CloudUploadIcon,
  ExternalLinkIcon,
  GitCommitIcon,
  LogInIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { GitHubIcon } from "./Icons";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
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
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
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
  gitInitMutationOptions,
  gitMergeBranchesMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRemoveWorktreeMutationOptions,
  gitRunStackedActionMutationOptions,
  gitStatusQueryOptions,
  gitWorktreesQueryOptions,
  invalidateGitQueries,
} from "~/lib/gitReactQuery";
import { preferredTerminalEditor, resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useComposerDraftStore } from "~/composerDraftStore";
import { newCommandId, newThreadId } from "~/lib/utils";
import { createDedicatedThreadWorkspace } from "~/threadWorktree";
import { formatWorktreePathForDisplay } from "~/worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface GitActionsControlProps {
  gitCwd: string | null;
  projectGitCwd: string | null;
  activeThreadId: ThreadId | null;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  forcePushOnlyProgress: boolean;
  onConfirmed?: () => void;
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function GitActionItemIcon({ icon }: { icon: GitActionIconName }) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <GitHubIcon />;
}

function formatGitHubTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function renderWorkspaceHealthBadge(input: {
  hasConflicts: boolean;
  hasWorkingTreeChanges: boolean;
}) {
  const badge = input.hasConflicts ? (
    <Badge variant="error">Conflicts</Badge>
  ) : input.hasWorkingTreeChanges ? (
    <Badge variant="warning">Dirty</Badge>
  ) : (
    <Badge variant="success">Clean</Badge>
  );

  const tooltip = input.hasConflicts
    ? "This worktree has unresolved merge conflicts. Resolve or abort the merge before continuing."
    : input.hasWorkingTreeChanges
      ? "This worktree has local changes. Dirty includes staged, unstaged, untracked, renamed, or deleted files."
      : "This worktree has no local file changes.";

  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function getCommitDisabledReason(input: {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasConflicts: boolean;
}): string | null {
  if (input.hasConflicts) {
    return "Resolve merge conflicts before committing.";
  }
  if (input.isBusy) {
    return "Git action in progress.";
  }
  if (!input.gitStatus) {
    return "Git status is unavailable.";
  }
  if (!input.gitStatus.hasWorkingTreeChanges) {
    return "Worktree is clean. Make changes before committing.";
  }
  return null;
}

function getPullDisabledReason(input: {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasConflicts: boolean;
}): string | null {
  if (input.hasConflicts) {
    return "Resolve merge conflicts before pulling.";
  }
  if (input.isBusy) {
    return "Git action in progress.";
  }
  if (!input.gitStatus) {
    return "Git status is unavailable.";
  }
  if (input.gitStatus.branch === null) {
    return "Detached HEAD: checkout a branch before pulling.";
  }
  if (input.gitStatus.hasWorkingTreeChanges) {
    return "Commit or stash local changes before pulling.";
  }
  if (input.gitStatus.behindCount === 0) {
    return "Branch is up to date with upstream.";
  }
  return null;
}

function getCommitPushDisabledReason(input: {
  gitStatus: GitStatusResult | null;
  isBusy: boolean;
  hasConflicts: boolean;
}): string | null {
  if (input.hasConflicts) {
    return "Resolve merge conflicts before pushing.";
  }
  if (!input.gitStatus) {
    return "Git status is unavailable.";
  }
  if (input.gitStatus.branch === null) {
    return "Detached HEAD: checkout a branch before pushing.";
  }
  if (input.isBusy) {
    return "Git action in progress.";
  }
  if (input.gitStatus.behindCount > 0) {
    return "Branch is behind upstream. Pull or rebase before pushing.";
  }
  if (!(input.gitStatus.hasWorkingTreeChanges || input.gitStatus.aheadCount > 0)) {
    return "No local changes or commits to push.";
  }
  return null;
}

function describeWorktreeState(input: {
  gitStatus: GitStatusResult | null;
  hasConflicts: boolean;
  hasWorkingTreeChanges: boolean;
}): { message: string; toneClassName: string } {
  if (!input.gitStatus) {
    return {
      message: "Refreshing git status.",
      toneClassName: "text-muted-foreground",
    };
  }

  if (input.hasConflicts) {
    return {
      message: "Resolve conflicts before commit, pull, push, or merge.",
      toneClassName: "text-destructive",
    };
  }

  if (input.gitStatus.branch === null) {
    return {
      message: "Detached HEAD. Checkout a branch to enable pull, push, and PR actions.",
      toneClassName: "text-warning",
    };
  }

  if (input.gitStatus.aheadCount > 0 && input.gitStatus.behindCount > 0) {
    return {
      message: `Ahead ${input.gitStatus.aheadCount} and behind ${input.gitStatus.behindCount}. Sync this branch before pushing or opening a PR.`,
      toneClassName: "text-warning",
    };
  }

  if (input.gitStatus.behindCount > 0 && input.hasWorkingTreeChanges) {
    return {
      message: `Behind ${input.gitStatus.behindCount}. Commit or stash local changes before pulling latest.`,
      toneClassName: "text-warning",
    };
  }

  if (input.gitStatus.behindCount > 0) {
    return {
      message: `Behind ${input.gitStatus.behindCount}. Pull latest before pushing or opening a PR.`,
      toneClassName: "text-warning",
    };
  }

  if (input.hasWorkingTreeChanges) {
    return {
      message: "Local changes ready to commit.",
      toneClassName: "text-warning",
    };
  }

  if (input.gitStatus.aheadCount > 0) {
    return {
      message: `Ahead ${input.gitStatus.aheadCount}. Push when ready.`,
      toneClassName: "text-success",
    };
  }

  return {
    message: "Up to date with upstream.",
    toneClassName: "text-success",
  };
}

function buildConflictDraftPrompt(input: {
  sourceBranch: string;
  targetBranch: string;
  targetWorktreePath: string;
  conflictedFiles: ReadonlyArray<string>;
}): string {
  const conflictedFilesSection =
    input.conflictedFiles.length > 0
      ? input.conflictedFiles.map((file) => `- ${file}`).join("\n")
      : "- No conflicted files were reported.";

  return [
    `Resolve merge conflicts from \`${input.sourceBranch}\` into \`${input.targetBranch}\`.`,
    "",
    "Context",
    `- Target branch: \`${input.targetBranch}\``,
    `- Source branch: \`${input.sourceBranch}\``,
    `- Target worktree: \`${input.targetWorktreePath}\``,
    "",
    "Conflicted files",
    conflictedFilesSection,
    "",
    "Instructions",
    "- Resolve only the listed merge conflicts in the target worktree.",
    "- Preserve both branch intents where possible.",
    "- Keep unrelated files unchanged.",
    "- Stop when the merge conflicts are cleared and summarize what changed.",
  ].join("\n");
}

export default function GitHubPanel({ gitCwd, projectGitCwd, activeThreadId }: GitActionsControlProps) {
  const navigate = useNavigate();
  const threads = useStore((store) => store.threads);
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const activeServerThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads],
  );
  const activeDraftThread = useComposerDraftStore((store) =>
    activeThreadId ? store.getDraftThread(activeThreadId) : null,
  );
  const getDraftThreadByProjectId = useComposerDraftStore((store) => store.getDraftThreadByProjectId);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftPromptsByThreadId = useComposerDraftStore((store) => store.draftsByThreadId);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const activeProjectId = activeServerThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const threadToastData = useMemo(
    () => (activeThreadId ? { threadId: activeThreadId } : undefined),
    [activeThreadId],
  );
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [issueState, setIssueState] = useState<"open" | "closed" | "all">("open");
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [mergeSourceBranch, setMergeSourceBranch] = useState("");
  const [lastMergeResult, setLastMergeResult] = useState<GitMergeBranchesResult | null>(null);

  const { data: gitStatus = null, error: gitStatusError } = useQuery(gitStatusQueryOptions(gitCwd));

  const { data: branchList = null } = useQuery(gitBranchesQueryOptions(gitCwd));
  const worktreesQuery = useQuery(gitWorktreesQueryOptions(projectGitCwd ?? gitCwd));
  const githubStatusQuery = useQuery(githubStatusQueryOptions(projectGitCwd));
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

  const initMutation = useMutation(gitInitMutationOptions({ cwd: gitCwd, queryClient }));
  const loginMutation = useMutation(githubLoginMutationOptions({ cwd: projectGitCwd, queryClient }));

  const githubIssuesQuery = useQuery(
    githubIssuesQueryOptions({
      cwd: projectGitCwd,
      state: issueState,
      limit: 20,
      enabled:
        githubStatusQuery.data?.installed === true &&
        githubStatusQuery.data?.authenticated === true &&
        githubStatusQuery.data?.repo !== null,
    }),
  );
  const isGitHubAuthenticated = githubStatusQuery.data?.authenticated === true;

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({ cwd: gitCwd, queryClient }),
  );
  const pullMutation = useMutation(gitPullMutationOptions({ cwd: gitCwd, queryClient }));
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const mergeBranchesMutation = useMutation(
    gitMergeBranchesMutationOptions({ cwd: projectGitCwd ?? gitCwd, queryClient }),
  );
  const abortMergeMutation = useMutation(
    gitAbortMergeMutationOptions({ cwd: projectGitCwd ?? gitCwd, queryClient }),
  );

  const isRunStackedActionRunning =
    useIsMutating({ mutationKey: gitMutationKeys.runStackedAction(gitCwd) }) > 0;
  const isPullRunning = useIsMutating({ mutationKey: gitMutationKeys.pull(gitCwd) }) > 0;
  const isMergeRunning =
    useIsMutating({ mutationKey: gitMutationKeys.mergeBranches(projectGitCwd ?? gitCwd) }) > 0;
  const isAbortMergeRunning =
    useIsMutating({ mutationKey: gitMutationKeys.abortMerge(projectGitCwd ?? gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const localBranches = useMemo(
    () => (branchList?.branches ?? []).filter((branch) => !branch.isRemote),
    [branchList?.branches],
  );
  const defaultBranch = useMemo(
    () => localBranches.find((branch) => branch.isDefault)?.name ?? null,
    [localBranches],
  );
  const worktrees = useMemo(() => worktreesQuery.data?.worktrees ?? [], [worktreesQuery.data?.worktrees]);
  const currentWorktree = useMemo(
    () =>
      worktrees.find((worktree) => worktree.isCurrent) ??
      worktrees.find((worktree) => worktree.path === (gitCwd ?? "")) ??
      null,
    [gitCwd, worktrees],
  );
  const linkedThreadCountByWorktreePath = useMemo(() => {
    const counts = new Map<string, number>();
    if (!activeProjectId) {
      return counts;
    }
    for (const thread of threads) {
      if (thread.projectId !== activeProjectId) {
        continue;
      }
      const targetPath = thread.worktreePath ?? projectGitCwd;
      if (!targetPath) {
        continue;
      }
      counts.set(targetPath, (counts.get(targetPath) ?? 0) + 1);
    }
    return counts;
  }, [activeProjectId, projectGitCwd, threads]);
  const activeWorkspacePath = currentWorktree?.path ?? gitCwd;
  const activeWorkspaceBranch = currentWorktree?.branch ?? gitStatusForActions?.branch ?? currentBranch;
  const activeWorkspaceName = activeWorkspacePath
    ? formatWorktreePathForDisplay(activeWorkspacePath)
    : "Unknown worktree";
  const activeWorkspaceLinkCount = activeWorkspacePath
    ? (linkedThreadCountByWorktreePath.get(activeWorkspacePath) ?? 0)
    : 0;
  const activeWorkspaceHasConflicts =
    currentWorktree?.hasConflicts === true ||
    (lastMergeResult?.status === "conflicted" && lastMergeResult.targetWorktreePath === activeWorkspacePath);
  const activeWorkspaceHasWorkingTreeChanges =
    currentWorktree?.hasWorkingTreeChanges ?? gitStatusForActions?.hasWorkingTreeChanges ?? false;
  const worktreeStateSummary = describeWorktreeState({
    gitStatus: gitStatusForActions,
    hasConflicts: activeWorkspaceHasConflicts,
    hasWorkingTreeChanges: activeWorkspaceHasWorkingTreeChanges,
  });
  const isDefaultBranch = useMemo(() => {
    const branchName = activeWorkspaceBranch;
    if (!branchName) return false;
    const current = branchList?.branches.find((branch) => branch.name === branchName);
    return current?.isDefault ?? (branchName === "main" || branchName === "master");
  }, [activeWorkspaceBranch, branchList?.branches]);

  useEffect(() => {
    const localBranchNames = localBranches.map((branch) => branch.name);
    if (localBranchNames.length === 0 || !activeWorkspaceBranch) {
      if (mergeSourceBranch.length > 0) {
        setMergeSourceBranch("");
      }
      return;
    }

    const suggestedSourceBranch =
      localBranchNames.find((branchName) => branchName !== activeWorkspaceBranch) ??
      "";

    if (
      mergeSourceBranch.length === 0 ||
      !localBranchNames.includes(mergeSourceBranch) ||
      mergeSourceBranch === activeWorkspaceBranch
    ) {
      setMergeSourceBranch(suggestedSourceBranch);
    }
  }, [activeWorkspaceBranch, localBranches, mergeSourceBranch]);

  useEffect(() => {
    if (
      lastMergeResult &&
      (lastMergeResult.targetWorktreePath !== activeWorkspacePath ||
        lastMergeResult.targetBranch !== activeWorkspaceBranch)
    ) {
      setLastMergeResult(null);
    }
  }, [activeWorkspaceBranch, activeWorkspacePath, lastMergeResult]);

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

  const openPathInEditor = useCallback(
    (targetPath: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      void api.shell.openInEditor(targetPath, preferredTerminalEditor()).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open path",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      });
    },
    [threadToastData],
  );

  const moveThreadToDedicatedWorkspace = useCallback(async () => {
    const api = readNativeApi();
    const baseCwd = projectGitCwd ?? gitCwd;
    if (!api || !activeThreadId || !baseCwd) {
      toastManager.add({
        type: "error",
        title: "Dedicated worktree creation is unavailable.",
        data: threadToastData,
      });
      return;
    }

    try {
      const preferredBaseBranch =
        activeServerThread?.branch ?? activeDraftThread?.branch ?? currentWorktree?.branch ?? defaultBranch;
      const workspace = await createDedicatedThreadWorkspace({
        api,
        cwd: baseCwd,
        preferredBaseBranch,
        queryClient,
      });

      if (activeServerThread) {
        if (activeServerThread.session) {
          await api.orchestration.dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeServerThread.id,
            createdAt: new Date().toISOString(),
          });
        }

        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeServerThread.id,
          branch: workspace.branch,
          worktreePath: workspace.worktreePath,
        });
        setThreadBranch(activeServerThread.id, workspace.branch, workspace.worktreePath);
      } else if (activeDraftThread && activeThreadId) {
        setDraftThreadContext(activeThreadId, {
          branch: workspace.branch,
          worktreePath: workspace.worktreePath,
          envMode: "worktree",
        });
      }

      toastManager.add({
        title: "Dedicated worktree ready",
        description: formatWorktreePathForDisplay(workspace.worktreePath),
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not create a dedicated worktree",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [
    activeDraftThread,
    activeServerThread,
    activeThreadId,
    currentWorktree?.branch,
    defaultBranch,
    gitCwd,
    projectGitCwd,
    queryClient,
    setDraftThreadContext,
    setThreadBranch,
    threadToastData,
  ]);

  const canMoveThreadToDedicatedWorkspace =
    activeThreadId !== null &&
    currentWorktree?.isMainWorktree === true &&
    !activeServerThread?.worktreePath &&
    !activeDraftThread?.worktreePath;

  const injectConflictDraft = useCallback(
    async (result: GitMergeBranchesResult) => {
      if (!activeProjectId) {
        toastManager.add({
          type: "error",
          title: "Could not resolve a target project for the conflict draft.",
          data: threadToastData,
        });
        return;
      }

      const targetServerThread =
        threads.find(
          (thread) =>
            thread.projectId === activeProjectId &&
            thread.branch === result.targetBranch &&
            (thread.worktreePath ?? projectGitCwd ?? null) === result.targetWorktreePath,
        ) ?? null;

      const targetDraftThread = getDraftThreadByProjectId(activeProjectId);
      const targetThreadId =
        targetServerThread?.id ?? targetDraftThread?.threadId ?? newThreadId();

      if (!targetServerThread) {
        if (!targetDraftThread) {
          setProjectDraftThreadId(activeProjectId, targetThreadId, {
            branch: result.targetBranch,
            worktreePath:
              worktreesQuery.data?.repoRoot === result.targetWorktreePath
                ? null
                : result.targetWorktreePath,
            envMode:
              worktreesQuery.data?.repoRoot === result.targetWorktreePath ? "local" : "worktree",
          });
        } else {
          setDraftThreadContext(targetThreadId, {
            branch: result.targetBranch,
            worktreePath:
              worktreesQuery.data?.repoRoot === result.targetWorktreePath
                ? null
                : result.targetWorktreePath,
            envMode:
              worktreesQuery.data?.repoRoot === result.targetWorktreePath ? "local" : "worktree",
          });
        }
      }

      const nextPrompt = buildConflictDraftPrompt(result);
      const existingPrompt = draftPromptsByThreadId[targetThreadId]?.prompt?.trim() ?? "";
      setPrompt(
        targetThreadId,
        existingPrompt.length > 0 ? `${existingPrompt}\n\n${nextPrompt}` : nextPrompt,
      );
      await navigate({
        to: "/$threadId",
        params: { threadId: targetThreadId },
      }).catch(() => undefined);
      toastManager.add({
        type: "success",
        title: "Conflict brief added to thread draft",
        description: `Prepared a draft for ${result.targetBranch}.`,
        data: {
          ...threadToastData,
          threadId: targetThreadId,
        },
      });
    },
    [
      activeProjectId,
      draftPromptsByThreadId,
      getDraftThreadByProjectId,
      navigate,
      projectGitCwd,
      setDraftThreadContext,
      setProjectDraftThreadId,
      setPrompt,
      threadToastData,
      threads,
      worktreesQuery.data?.repoRoot,
    ],
  );

  const runLocalMerge = useCallback(async () => {
    if (!mergeSourceBranch || !activeWorkspaceBranch) {
      toastManager.add({
        type: "warning",
        title: "Select a source branch before merging.",
        data: threadToastData,
      });
      return;
    }
    if (mergeSourceBranch === activeWorkspaceBranch) {
      toastManager.add({
        type: "warning",
        title: "Source and target branches must be different.",
        data: threadToastData,
      });
      return;
    }

    try {
      const result = await mergeBranchesMutation.mutateAsync({
        sourceBranch: mergeSourceBranch,
        targetBranch: activeWorkspaceBranch,
      });
      setLastMergeResult(result);
      toastManager.add({
        type: result.status === "merged" ? "success" : "warning",
        title:
          result.status === "merged"
            ? `Merged ${result.sourceBranch} into ${result.targetBranch}`
            : `Merge conflicts in ${result.targetBranch}`,
        description:
          result.status === "merged"
            ? undefined
            : `${result.conflictedFiles.length} conflicted file${result.conflictedFiles.length === 1 ? "" : "s"}.`,
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Local merge failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [
    activeWorkspaceBranch,
    mergeBranchesMutation,
    mergeSourceBranch,
    threadToastData,
  ]);

  const abortMergeForWorktree = useCallback(
    async (targetCwd: string) => {
      try {
        const result = await abortMergeMutation.mutateAsync(targetCwd);
        if (result.status === "aborted") {
          setLastMergeResult((current) =>
            current?.targetWorktreePath === targetCwd ? null : current,
          );
        }
        toastManager.add({
          type: result.status === "aborted" ? "success" : "warning",
          title:
            result.status === "aborted"
              ? "Merge aborted"
              : "No merge in progress for that worktree",
          data: threadToastData,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not abort merge",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [abortMergeMutation, threadToastData],
  );

  const removeWorktree = useCallback(
    async (worktreePath: string) => {
      const repoCwd = projectGitCwd ?? gitCwd;
      if (!repoCwd) {
        return;
      }
      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: repoCwd,
          path: worktreePath,
          force: true,
        });
        toastManager.add({
          type: "success",
          title: "Worktree removed",
          description: formatWorktreePathForDisplay(worktreePath),
          data: threadToastData,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not remove worktree",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [gitCwd, projectGitCwd, removeWorktreeMutation, threadToastData],
  );

  const openExistingPr = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
        data: threadToastData,
      });
      return;
    }
    const prUrl = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr.url : null;
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
  }, [gitStatusForActions?.pr?.state, gitStatusForActions?.pr?.url, threadToastData]);

  const runGitActionWithToast = useCallback(
    async ({
      action,
      commitMessage,
      forcePushOnlyProgress = false,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      isDefaultBranchOverride,
      progressToastId,
    }: {
      action: GitStackedAction;
      commitMessage?: string;
      forcePushOnlyProgress?: boolean;
      onConfirmed?: () => void;
      skipDefaultBranchPrompt?: boolean;
      statusOverride?: GitStatusResult | null;
      featureBranch?: boolean;
      isDefaultBranchOverride?: boolean;
      progressToastId?: GitActionToastId;
    }) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.branch ?? null;
      const actionIsDefaultBranch = isDefaultBranchOverride ?? (featureBranch ? false : isDefaultBranch);
      const includesCommit =
        !forcePushOnlyProgress && (action === "commit" || !!actionStatus?.hasWorkingTreeChanges);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (action !== "commit_push" && action !== "commit_push_pr") {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          forcePushOnlyProgress,
          ...(onConfirmed ? { onConfirmed } : {}),
        });
        return;
      }
      onConfirmed?.();

      const pushTarget = !featureBranch && actionBranch ? `origin/${actionBranch}` : undefined;
      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        forcePushOnly: forcePushOnlyProgress,
        featureBranch,
        ...(pushTarget ? { pushTarget } : {}),
      });
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          timeout: 0,
          data: threadToastData,
        });

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          timeout: 0,
          data: threadToastData,
        });
      }

      let stageIndex = 0;
      const stageInterval = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, progressStages.length - 1);
        toastManager.update(resolvedProgressToastId, {
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
        ...(featureBranch ? { featureBranch } : {}),
      });

      try {
        const result = await promise;
        stopProgressUpdates();
        const resultToast = summarizeGitResult(result);

        const existingOpenPrUrl = actionStatus?.pr?.state === "open" ? actionStatus.pr.url : undefined;
        const prUrl = result.pr.url ?? existingOpenPrUrl;
        const shouldOfferPushCta = action === "commit" && result.commit.status === "created";
        const shouldOfferOpenPrCta =
          (action === "commit_push" || action === "commit_push_pr") &&
          !!prUrl &&
          (!actionIsDefaultBranch ||
            result.pr.status === "created" ||
            result.pr.status === "opened_existing");
        const shouldOfferCreatePrCta =
          action === "commit_push" &&
          !prUrl &&
          result.push.status === "pushed" &&
          !actionIsDefaultBranch;
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        toastManager.update(resolvedProgressToastId, {
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
                      statusOverride: actionStatus,
                      isDefaultBranchOverride: actionIsDefaultBranch,
                    });
                  },
                },
              }
            : shouldOfferOpenPrCta
              ? {
                  actionProps: {
                    children: "Open PR",
                    onClick: () => {
                      const api = readNativeApi();
                      if (!api) return;
                      closeResultToast();
                      void api.shell.openExternal(prUrl);
                    },
                  },
                }
              : shouldOfferCreatePrCta
                ? {
                    actionProps: {
                      children: "Create PR",
                      onClick: () => {
                        closeResultToast();
                        void runGitActionWithToast({
                          action: "commit_push_pr",
                          forcePushOnlyProgress: true,
                          statusOverride: actionStatus,
                          isDefaultBranchOverride: actionIsDefaultBranch,
                        });
                      },
                    },
                  }
                : {}),
        });
      } catch (err) {
        stopProgressUpdates();
        toastManager.update(resolvedProgressToastId, {
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },

    [
      isDefaultBranch,
      runImmediateGitActionMutation,
      setPendingDefaultBranchAction,
      threadToastData,
      gitStatusForActions,
    ],
  );

  const continuePendingDefaultBranchAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction, runGitActionWithToast]);

  const checkoutNewBranchAndRunAction = useCallback(
    (actionParams: {
      action: GitStackedAction;
      commitMessage?: string;
      forcePushOnlyProgress?: boolean;
      onConfirmed?: () => void;
    }) => {
      void runGitActionWithToast({
        ...actionParams,
        featureBranch: true,
        skipDefaultBranchPrompt: true,
      });
    },
    [runGitActionWithToast],
  );

  const checkoutFeatureBranchAndContinuePendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, forcePushOnlyProgress, onConfirmed } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    checkoutNewBranchAndRunAction({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      forcePushOnlyProgress,
      ...(onConfirmed ? { onConfirmed } : {}),
    });
  }, [pendingDefaultBranchAction, checkoutNewBranchAndRunAction]);

  const runDialogActionOnNewBranch = useCallback(() => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");

    checkoutNewBranchAndRunAction({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
    });
  }, [isCommitDialogOpen, dialogCommitMessage, checkoutNewBranchAndRunAction]);

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

  const openExternalUrl = useCallback(
    async (url: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link opening is unavailable.",
          data: threadToastData,
        });
        return;
      }

      await api.shell.openExternal(url);
    },
    [threadToastData],
  );

  const runDialogAction = useCallback(() => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
    });
  }, [
    dialogCommitMessage,
    isCommitDialogOpen,
    runGitActionWithToast,
    setDialogCommitMessage,
    setIsCommitDialogOpen,
  ]);

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readNativeApi();
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
    [gitCwd, threadToastData],
  );

  const pullLatest = useCallback(() => {
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
  }, [pullMutation, threadToastData]);

  const verifyGitHubAuth = useCallback(async () => {
    const result = await githubStatusQuery.refetch();

    if (result.error) {
      toastManager.add({
        type: "error",
        title: "GitHub verification failed",
        description: result.error.message,
        data: threadToastData,
      });
      return;
    }

    if (!result.data?.installed) {
      toastManager.add({
        type: "warning",
        title: "GitHub CLI is not installed",
        description: "Install `gh` on PATH to enable GitHub actions.",
        data: threadToastData,
      });
      return;
    }

    if (!result.data.authenticated) {
      toastManager.add({
        type: "warning",
        title: "GitHub CLI is not authenticated",
        description: "Run the auth flow to connect `gh`.",
        data: threadToastData,
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: "GitHub verified",
      description: result.data.accountLogin
        ? `Authenticated as @${result.data.accountLogin}.`
        : "GitHub CLI is authenticated.",
      data: threadToastData,
    });
  }, [githubStatusQuery, threadToastData]);

  const commitItem = gitActionMenuItems.find((item) => item.id === "commit") ?? null;
  const prItem = gitActionMenuItems.find((item) => item.id === "pr") ?? null;
  const githubRepoUrl = githubStatusQuery.data?.repo?.url ?? null;
  const githubRepoSettingsUrl = githubRepoUrl ? `${githubRepoUrl}/settings` : null;
  const issuesDisabled =
    githubIssuesQuery.error?.message.toLowerCase().includes("disabled issues") ?? false;
  const commitPushAvailable =
    !!gitStatusForActions &&
    gitStatusForActions.branch !== null &&
    !isGitActionRunning &&
    (gitStatusForActions.hasWorkingTreeChanges || gitStatusForActions.aheadCount > 0);
  const commitDisabledReason = getCommitDisabledReason({
    gitStatus: gitStatusForActions,
    isBusy: isGitActionRunning,
    hasConflicts: activeWorkspaceHasConflicts,
  });
  const pullDisabledReason = getPullDisabledReason({
    gitStatus: gitStatusForActions,
    isBusy: isGitActionRunning,
    hasConflicts: activeWorkspaceHasConflicts,
  });
  const commitPushDisabledReason = getCommitPushDisabledReason({
    gitStatus: gitStatusForActions,
    isBusy: isGitActionRunning,
    hasConflicts: activeWorkspaceHasConflicts,
  });
  const conflictDraftReady =
    lastMergeResult?.status === "conflicted" &&
    lastMergeResult.targetWorktreePath === activeWorkspacePath;
  const actionStatusMessage = activeWorkspaceHasConflicts
    ? "Resolve merge conflicts in this worktree before running more Git actions."
    : isGitStatusOutOfSync
      ? "Refreshing git status."
      : gitStatusError?.message ?? null;
  const actionStatusToneClassName = activeWorkspaceHasConflicts || gitStatusError
    ? "text-destructive"
    : "text-muted-foreground";

  if (!gitCwd) return null;

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-card text-foreground">
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <GitHubIcon className="size-4" />
                    <span className="text-sm font-medium">GitHub</span>
                    {githubStatusQuery.data?.installed ? (
                      <Badge
                        variant={githubStatusQuery.data.authenticated ? "success" : "warning"}
                        className="h-5"
                      >
                        {githubStatusQuery.data.authenticated ? "Ready" : "Auth needed"}
                      </Badge>
                    ) : (
                      <Badge variant="error" className="h-5">
                        Missing gh
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {githubStatusQuery.data?.repo?.nameWithOwner ?? (isRepo ? "Git actions and repository status" : "Initialize Git to enable repository actions")}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    void invalidateGitQueries(queryClient);
                    void invalidateGitHubQueries(queryClient);
                  }}
                  aria-label="Refresh GitHub menu"
                >
                  <RefreshCcwIcon
                    className={`size-3.5 ${
                      githubStatusQuery.isFetching || githubIssuesQuery.isFetching ? "animate-spin" : ""
                    }`}
                  />
                </Button>
              </div>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-5 p-4">
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Active worktree
                    </h3>
                    {gitStatusForActions?.branch && (
                      <Badge variant="outline" className="max-w-40 truncate">
                        {gitStatusForActions.branch}
                      </Badge>
                    )}
                  </div>

                  {!isRepo ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={initMutation.isPending}
                      onClick={() => initMutation.mutate()}
                      className="w-full justify-start"
                    >
                      {initMutation.isPending ? "Initializing Git..." : "Initialize Git"}
                    </Button>
                  ) : worktreesQuery.isLoading || worktreesQuery.isFetching ? (
                    <p className="text-sm text-muted-foreground">Loading worktree...</p>
                  ) : !currentWorktree ? (
                    <p className="text-sm text-muted-foreground">No active worktree detected.</p>
                  ) : (
                    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {activeWorkspaceBranch ?? "Detached HEAD"}
                            </p>
                            {!currentWorktree.isMainWorktree && (
                              <Badge variant="secondary">Linked worktree</Badge>
                            )}
                            {isDefaultBranch && <Badge variant="outline">Default branch</Badge>}
                          </div>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {activeWorkspacePath}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {renderWorkspaceHealthBadge({
                              hasConflicts: activeWorkspaceHasConflicts,
                              hasWorkingTreeChanges: activeWorkspaceHasWorkingTreeChanges,
                            })}
                            {gitStatusForActions && gitStatusForActions.aheadCount > 0 && (
                              <Badge variant="secondary">Ahead {gitStatusForActions.aheadCount}</Badge>
                            )}
                            {gitStatusForActions && gitStatusForActions.behindCount > 0 && (
                              <Badge variant="warning">Behind {gitStatusForActions.behindCount}</Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                            <span>
                              {activeWorkspaceLinkCount} linked thread
                              {activeWorkspaceLinkCount === 1 ? "" : "s"}
                            </span>
                            <span>{activeWorkspaceName}</span>
                          </div>
                          <p className={`text-xs ${worktreeStateSummary.toneClassName}`}>
                            {worktreeStateSummary.message}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => openPathInEditor(currentWorktree.path)}
                          >
                            Open
                          </Button>
                          {!currentWorktree.isMainWorktree && (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={removeWorktreeMutation.isPending || currentWorktree.hasConflicts}
                              onClick={() => {
                                void removeWorktree(currentWorktree.path);
                              }}
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      </div>

                      {canMoveThreadToDedicatedWorkspace && (
                        <div className="rounded-lg border border-border bg-background p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium text-foreground">Create dedicated worktree</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Start this thread in an isolated worktree from the current branch.
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                void moveThreadToDedicatedWorkspace();
                              }}
                            >
                              Create dedicated worktree
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Merge into this worktree
                    </h3>
                    {isDefaultBranch && <Badge variant="outline">Default branch</Badge>}
                  </div>

                  {!isRepo ? (
                    <p className="text-sm text-muted-foreground">
                      Initialize Git to enable local merge workflows.
                    </p>
                  ) : localBranches.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No local branches are available.</p>
                  ) : (
                    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">Merge into this worktree</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Target worktree: {activeWorkspaceName}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Target branch: {activeWorkspaceBranch ?? "Detached HEAD"}
                        </p>
                        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                          {activeWorkspacePath}
                        </p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <label className="space-y-1 text-sm">
                          <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                            Source branch
                          </span>
                          <select
                            className="flex min-h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
                            value={mergeSourceBranch}
                            onChange={(event) => setMergeSourceBranch(event.target.value)}
                            disabled={localBranches.length < 2}
                          >
                            {mergeSourceBranch.length === 0 && (
                              <option value="">No merge candidates</option>
                            )}
                            {localBranches
                              .filter((branch) => branch.name !== activeWorkspaceBranch)
                              .map((branch) => (
                                <option key={branch.name} value={branch.name}>
                                  {branch.name}
                                </option>
                              ))}
                          </select>
                        </label>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            disabled={
                              isMergeRunning ||
                              !activeWorkspaceBranch ||
                              mergeSourceBranch.length === 0 ||
                              activeWorkspaceHasWorkingTreeChanges
                            }
                            onClick={() => {
                              void runLocalMerge();
                            }}
                          >
                            {isMergeRunning ? "Merging..." : "Merge source into this worktree"}
                          </Button>
                          {activeWorkspaceHasConflicts && currentWorktree && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isAbortMergeRunning}
                              onClick={() => {
                                void abortMergeForWorktree(currentWorktree.path);
                              }}
                            >
                              Abort merge
                            </Button>
                          )}
                        </div>
                      </div>

                      {!activeWorkspaceBranch && (
                        <p className="text-xs text-muted-foreground">
                          Checkout a branch before merging.
                        </p>
                      )}
                      {activeWorkspaceBranch && mergeSourceBranch.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Create another local branch to merge into this worktree.
                        </p>
                      )}
                      {activeWorkspaceHasWorkingTreeChanges && !activeWorkspaceHasConflicts && (
                        <p className="text-xs text-warning">
                          This worktree has local changes. Clean it before merging.
                        </p>
                      )}

                      {lastMergeResult && (
                        <div className="rounded-lg border border-border bg-background p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium">
                              {lastMergeResult.status === "merged"
                                ? `Merged ${lastMergeResult.sourceBranch} into ${lastMergeResult.targetBranch}`
                                : `Conflicts while merging ${lastMergeResult.sourceBranch} into ${lastMergeResult.targetBranch}`}
                            </p>
                            <Badge
                              variant={lastMergeResult.status === "merged" ? "success" : "error"}
                            >
                              {lastMergeResult.status === "merged" ? "Merged" : "Conflicted"}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatWorktreePathForDisplay(lastMergeResult.targetWorktreePath)}
                          </p>
                          {lastMergeResult.status === "conflicted" && (
                            <p className="mt-3 text-xs text-muted-foreground">
                              Use Actions to draft a conflict brief or abort the merge.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Actions
                    </h3>
                  </div>

                  {!isRepo ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={initMutation.isPending}
                      onClick={() => initMutation.mutate()}
                      className="w-full justify-start"
                    >
                      {initMutation.isPending ? "Initializing Git..." : "Initialize Git"}
                    </Button>
                  ) : (
                    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Button
                          size="sm"
                          disabled={commitDisabledReason !== null}
                          onClick={() => {
                            if (commitItem) {
                              openDialogForMenuItem(commitItem);
                            }
                          }}
                          className="justify-start"
                        >
                          <GitCommitIcon className="size-4" />
                          Commit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pullDisabledReason !== null}
                          onClick={pullLatest}
                          className="justify-start"
                        >
                          <RefreshCcwIcon className="size-4" />
                          Pull latest
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={commitPushDisabledReason !== null}
                          onClick={() => {
                            void runGitActionWithToast({ action: "commit_push" });
                          }}
                          className="justify-between"
                        >
                          <span className="flex items-center gap-2">
                            <CloudUploadIcon className="size-4" />
                            Commit & push
                          </span>
                          {commitPushAvailable && commitPushDisabledReason === null && (
                            <span className="text-[10px] text-muted-foreground">Fast path</span>
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!prItem || prItem.disabled || activeWorkspaceHasConflicts}
                          onClick={() => {
                            if (prItem) {
                              openDialogForMenuItem(prItem);
                            }
                          }}
                          className="justify-between"
                        >
                          <span className="flex items-center gap-2">
                            <GitActionItemIcon icon="pr" />
                            {prItem?.label ?? "Create PR"}
                          </span>
                          {gitStatusForActions?.pr?.state === "open" ? (
                            <ExternalLinkIcon className="size-4 text-muted-foreground" />
                          ) : null}
                        </Button>
                      </div>

                      {actionStatusMessage && (
                        <p className={`text-xs ${actionStatusToneClassName}`}>{actionStatusMessage}</p>
                      )}

                      {(conflictDraftReady || activeWorkspaceHasConflicts) && (
                        <div className="flex flex-wrap gap-2">
                          {conflictDraftReady && lastMergeResult && (
                            <Button
                              size="xs"
                              onClick={() => {
                                void injectConflictDraft(lastMergeResult);
                              }}
                            >
                              Draft conflict brief
                            </Button>
                          )}
                          {activeWorkspaceHasConflicts && currentWorktree && (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={isAbortMergeRunning}
                              onClick={() => {
                                void abortMergeForWorktree(currentWorktree.path);
                              }}
                            >
                              Abort merge
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Auth
                    </h3>
                    {githubStatusQuery.data?.accountLogin && (
                      <Badge variant="outline">@{githubStatusQuery.data.accountLogin}</Badge>
                    )}
                  </div>

                  {!githubStatusQuery.data?.installed ? (
                    <p className="text-sm text-muted-foreground">
                      GitHub CLI is not installed on PATH.
                    </p>
                  ) : (
                    <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={githubStatusQuery.data.authenticated ? "success" : "warning"}>
                          {githubStatusQuery.data.authenticated ? "Authenticated" : "Not authenticated"}
                        </Badge>
                        {githubStatusQuery.data.gitProtocol && (
                          <Badge variant="outline">{githubStatusQuery.data.gitProtocol}</Badge>
                        )}
                        {githubStatusQuery.data.tokenSource && (
                          <Badge variant="outline">{githubStatusQuery.data.tokenSource}</Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={isGitHubAuthenticated ? githubStatusQuery.isFetching : loginMutation.isPending}
                          onClick={() => {
                            if (isGitHubAuthenticated) {
                              void verifyGitHubAuth();
                              return;
                            }
                            loginMutation.mutate();
                          }}
                          className="justify-start"
                        >
                          <LogInIcon className="size-4" />
                          {isGitHubAuthenticated
                            ? githubStatusQuery.isFetching
                              ? "Verifying..."
                              : "Verify gh"
                            : loginMutation.isPending
                              ? "Authenticating..."
                              : "Authenticate gh"}
                        </Button>
                        {githubStatusQuery.data.repo?.url && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void openExternalUrl(githubStatusQuery.data!.repo!.url)}
                          >
                            <ExternalLinkIcon className="size-4" />
                            Open repo
                          </Button>
                        )}
                      </div>
                      {githubStatusQuery.data.scopes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {githubStatusQuery.data.scopes.map((scope) => (
                            <Badge key={scope} variant="outline">
                              {scope}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {loginMutation.error && (
                        <p className="text-xs text-destructive">
                          {loginMutation.error.message}
                        </p>
                      )}
                    </div>
                  )}
                </section>

                <section className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Issues
                    </h3>
                    <div className="flex gap-1">
                      {[
                        { label: "Open", value: "open" as const },
                        { label: "Closed", value: "closed" as const },
                        { label: "All", value: "all" as const },
                      ].map((item) => (
                        <Button
                          key={item.value}
                          variant={issueState === item.value ? "default" : "outline"}
                          size="xs"
                          onClick={() => setIssueState(item.value)}
                        >
                          {item.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {!githubStatusQuery.data?.installed ? (
                    <p className="text-sm text-muted-foreground">Install `gh` to browse issues.</p>
                  ) : !githubStatusQuery.data.authenticated ? (
                    <p className="text-sm text-muted-foreground">
                      Authenticate `gh` to load issues for this repository.
                    </p>
                  ) : !githubStatusQuery.data.repo ? (
                    <p className="text-sm text-muted-foreground">
                      This project does not resolve to a GitHub repository yet.
                    </p>
                  ) : githubIssuesQuery.isLoading || githubIssuesQuery.isFetching ? (
                    <p className="text-sm text-muted-foreground">Loading issues...</p>
                  ) : issuesDisabled ? (
                    <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
                      <p className="text-sm text-muted-foreground">
                        Issues are disabled for this repository.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {githubRepoUrl && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void openExternalUrl(githubRepoUrl)}
                          >
                            <ExternalLinkIcon className="size-4" />
                            Open repo
                          </Button>
                        )}
                        {githubRepoSettingsUrl && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void openExternalUrl(githubRepoSettingsUrl)}
                          >
                            <ExternalLinkIcon className="size-4" />
                            Enable issues
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : githubIssuesQuery.error ? (
                    <p className="text-sm text-destructive">{githubIssuesQuery.error.message}</p>
                  ) : githubIssuesQuery.data && githubIssuesQuery.data.issues.length > 0 ? (
                    <div className="space-y-2">
                      {githubIssuesQuery.data.issues.map((issue) => (
                        <button
                          type="button"
                          key={issue.number}
                          className="flex w-full flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-accent/50"
                          onClick={() => void openExternalUrl(issue.url)}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">#{issue.number}</span>
                                <Badge variant={issue.state === "open" ? "success" : "secondary"}>
                                  {issue.state}
                                </Badge>
                                {issue.author && <span>@{issue.author}</span>}
                              </div>
                              <p className="mt-1 text-sm font-medium text-foreground">{issue.title}</p>
                            </div>
                            <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" />
                          </div>
                          {(issue.labels.length > 0 || issue.assignees.length > 0) && (
                            <div className="flex flex-wrap gap-1.5 text-xs">
                              {issue.labels.map((label) => (
                                <Badge key={label.name} variant="outline">
                                  {label.name}
                                </Badge>
                              ))}
                              {issue.assignees.map((assignee) => (
                                <Badge key={assignee.login} variant="outline">
                                  @{assignee.login}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground">
                            Updated {formatGitHubTimestamp(issue.updatedAt)}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No issues matched this filter.</p>
                  )}
                </section>
              </div>
            </ScrollArea>
          </div>
      </div>

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
            <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-lg border border-input bg-muted/40 p-3 text-xs">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{gitStatusForActions?.branch ?? "(detached HEAD)"}</span>
                  {isDefaultBranch && (
                    <span className="text-right text-warning text-xs">Warning: default branch</span>
                  )}
                </span>
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
            <div className="space-y-1">
              <p className="text-xs font-medium">Commit message (optional)</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder="Leave empty to auto-generate"
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setDialogCommitMessage("");
              }}
            >
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={runDialogActionOnNewBranch}>
              Commit on new branch
            </Button>
            <Button size="sm" onClick={runDialogAction}>
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

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
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDefaultBranchAction(null)}>
              Abort
            </Button>
            <Button variant="outline" size="sm" onClick={continuePendingDefaultBranchAction}>
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            <Button size="sm" onClick={checkoutFeatureBranchAndContinuePendingAction}>
              Checkout feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
