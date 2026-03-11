import type { GitMergeBranchesResult, GitStackedAction, GitStatusResult, ThreadId } from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LogInIcon,
  RefreshCcwIcon,
  UploadIcon,
} from "lucide-react";
import { GitHubIcon } from "./Icons";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionMenuItem,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  summarizeGitResult,
} from "./GitActionsControl.logic";
import {
  buildPrimaryWorkspaceResolutionPrompt,
  buildResolveConflictPrompt,
  buildCommitToBranchLabel,
  deriveWorkspaceStatusInfo,
  resolveDefaultMergeSourceBranch,
  resolveCommitToBranchDisabledReason,
  resolveDedicatedWorkspaceActionState,
  type WorkspaceStatusLevel as StatusLevel,
} from "./GitHubPanel.logic";
import {
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
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
import { buildTemporaryWorktreeBranchName } from "~/gitWorktree";
import { cn, newCommandId, newThreadId } from "~/lib/utils";
import { preferredTerminalEditor, resolvePathLinkTarget } from "~/terminal-links";
import { readNativeApi } from "~/nativeApi";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useStore } from "~/store";
import { formatWorktreePathForDisplay } from "~/worktreeCleanup";

interface GitActionsControlProps {
  workspaceCwd: string | null;
  repoCwd: string | null;
  repoRoot: string | null;
  scopeKind: "project" | "thread";
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

// =============================================================================
// Status Indicator Component
// =============================================================================

interface StatusDotProps {
  level: StatusLevel;
  pulse?: boolean;
  className?: string;
}

function StatusDot({ level, pulse, className }: StatusDotProps) {
  const colors: Record<StatusLevel, string> = {
    success: "bg-emerald-500",
    warning: "bg-amber-500",
    error: "bg-red-500",
    neutral: "bg-neutral-400 dark:bg-neutral-500",
    info: "bg-blue-500",
  };

  return (
    <span className={cn("relative flex size-2", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            colors[level]
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", colors[level])} />
    </span>
  );
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
// Copyable Path Component
// =============================================================================

function CopyablePath({ path, className }: { path: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [path]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "group flex items-center gap-1.5 rounded px-1.5 py-0.5 -mx-1.5 text-left transition-colors hover:bg-accent/50",
        className
      )}
      title="Click to copy path"
    >
      <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-success-foreground" />
      ) : (
        <CopyIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  );
}

// =============================================================================
// Section Components
// =============================================================================

interface SectionProps {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
}

function Section({ title, children, actions, defaultOpen = true, collapsible = false }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (!collapsible) {
    return (
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            {title}
          </h3>
          {actions}
        </div>
        {children}
      </section>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground transition-colors hover:text-foreground">
            {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
            {title}
          </CollapsibleTrigger>
          {actions}
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

// =============================================================================
// Workspace Card Component
// =============================================================================

interface WorkspaceCardProps {
  isPrimary: boolean;
  name: string;
  branch: string;
  targetBranch: string | null;
  path: string | null;
  statusLevel: StatusLevel;
  statusLabel: string;
  aheadCount: number;
  behindCount: number;
  hasOpenPr: boolean;
  isDefaultBranch: boolean;
  onOpen: () => void;
}

function WorkspaceCard({
  isPrimary,
  name,
  branch,
  targetBranch,
  path,
  statusLevel,
  statusLabel,
  aheadCount,
  behindCount,
  hasOpenPr,
  isDefaultBranch,
  onOpen,
}: WorkspaceCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        isPrimary
          ? "border-border bg-card"
          : "border-primary/20 bg-primary/[0.02] dark:bg-primary/[0.04]"
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2Icon
            className={cn("size-4 shrink-0", isPrimary ? "text-muted-foreground" : "text-primary")}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{name}</span>
              {!isPrimary && (
                <Badge variant="secondary" size="sm">
                  Dedicated
                </Badge>
              )}
            </div>
          </div>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onOpen} title="Open in editor">
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      </div>

      {/* Branch flow: current → target */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <div className="flex items-center gap-1 text-muted-foreground">
          <GitBranchIcon className="size-3" />
          <span className="font-mono">{branch}</span>
        </div>
        {targetBranch && !isDefaultBranch && (
          <>
            <ArrowRightIcon className="size-3 text-muted-foreground/50" />
            <span className="font-mono text-muted-foreground">{targetBranch}</span>
          </>
        )}
        {isDefaultBranch && (
          <Badge variant="warning" size="sm">
            default
          </Badge>
        )}
      </div>

      {/* Status row */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <div className="flex items-center gap-1.5">
          <StatusDot level={statusLevel} pulse={statusLevel === "error"} />
          <span className="text-muted-foreground">{statusLabel}</span>
        </div>
        {aheadCount > 0 && (
          <span className="flex items-center gap-1 text-success-foreground">
            <UploadIcon className="size-3" />
            {aheadCount}
          </span>
        )}
        {behindCount > 0 && (
          <span className="flex items-center gap-1 text-warning-foreground">
            <DownloadIcon className="size-3" />
            {behindCount}
          </span>
        )}
        {hasOpenPr && (
          <Badge variant="info" size="sm">
            <GitPullRequestIcon className="size-3" />
            PR
          </Badge>
        )}
      </div>

      {/* Path */}
      {path && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <CopyablePath path={path} />
        </div>
      )}
    </div>
  );
}


// =============================================================================
// Format Helpers
// =============================================================================

function formatGitHubTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}


// =============================================================================
// Main Component
// =============================================================================

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

export default function GitHubPanel({
  workspaceCwd,
  repoCwd,
  repoRoot,
  scopeKind: _scopeKind,
  activeThreadId,
}: GitActionsControlProps) {
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
  const getDraftThreadByProjectId = useComposerDraftStore((store) => store.getDraftThreadByProjectId);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const activeProjectId = activeServerThread?.projectId ?? activeDraftThread?.projectId ?? null;
  const hasServerThread = activeServerThread !== null;
  const activeThreadBranch = activeServerThread?.branch ?? activeDraftThread?.branch ?? null;
  const activeWorktreePath = activeServerThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null;
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
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [issueState, setIssueState] = useState<"open" | "closed" | "all">("open");
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [mergeSourceBranch, setMergeSourceBranch] = useState("");
  const [lastMergeResult, setLastMergeResult] = useState<GitMergeBranchesResult | null>(null);
  const [mergeExpanded, setMergeExpanded] = useState(false);
  const [promotionTargetBranch, setPromotionTargetBranch] = useState<string | null>(null);
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
    setIssueState("open");
    setMergeSourceBranch("");
    setLastMergeResult(null);
    setPendingDefaultBranchAction(null);
    setDialogCommitMessage("");
    setIsCommitDialogOpen(false);
    setMergeExpanded(false);
    setPromotionTargetBranch(null);
    setIsPromoteDialogOpen(false);
    void invalidateGitQueries(queryClient);
    void invalidateGitHubQueries(queryClient);
  }, [activeThreadId, queryClient, repoCwd, workspaceCwd]);

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
  const isMergeRunning = useIsMutating({ mutationKey: gitMutationKeys.mergeBranches(workspaceCwd) }) > 0;
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
    [activeWorkspaceHasConflicts, activeWorkspaceMerge.inProgress, gitStatusForActions?.hasWorkingTreeChanges]
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

  const focusDraftThread = useCallback(
    async (branch: string, worktreePath: string) => {
      if (!activeProjectId) {
        return;
      }

      if (!activeServerThread && activeThreadId && activeDraftThread?.projectId === activeProjectId) {
        setDraftThreadContext(activeThreadId, {
          branch,
          worktreePath,
          envMode: "worktree",
        });
        return;
      }

      const existingDraftThread = getDraftThreadByProjectId(activeProjectId);
      const targetThreadId = existingDraftThread?.threadId ?? newThreadId();
      setProjectDraftThreadId(activeProjectId, targetThreadId, {
        branch,
        worktreePath,
        envMode: "worktree",
      });
      if (targetThreadId !== activeThreadId) {
        await navigate({
          to: "/$threadId",
          params: { threadId: targetThreadId },
        });
      }
    },
    [
      activeDraftThread?.projectId,
      activeProjectId,
      activeServerThread,
      activeThreadId,
      getDraftThreadByProjectId,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const createDedicatedWorkspace = useCallback(async () => {
    if (!repoCwd || !activeWorkspaceBranch) {
      return;
    }

    try {
      const result = await createWorktreeMutation.mutateAsync({
        cwd: repoCwd,
        branch: activeWorkspaceBranch,
        newBranch: buildTemporaryWorktreeBranchName(),
      });
      await focusDraftThread(result.worktree.branch, result.worktree.path);
      toastManager.add({
        type: "success",
        title: "Workspace created",
        description: formatWorktreePathForDisplay(result.worktree.path),
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to create workspace",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [
    activeWorkspaceBranch,
    createWorktreeMutation,
    focusDraftThread,
    repoCwd,
    threadToastData,
  ]);

  const focusPrimaryWorkspaceDraft = useCallback(async () => {
    if (!activeProjectId) {
      return null;
    }

    const existingDraftThread = getDraftThreadByProjectId(activeProjectId);
    const canReuseActiveDraft =
      !activeServerThread &&
      activeThreadId !== null &&
      activeDraftThread?.projectId === activeProjectId &&
      activeDraftThread.worktreePath === null;
    const targetThreadId = canReuseActiveDraft
      ? activeThreadId
      : existingDraftThread?.worktreePath === null
        ? existingDraftThread.threadId
        : newThreadId();

    if (!targetThreadId) {
      return null;
    }

    setProjectDraftThreadId(activeProjectId, targetThreadId, {
      branch: activeThreadBranch ?? activeWorkspaceBranch ?? null,
      worktreePath: null,
      envMode: "local",
    });

    if (targetThreadId !== activeThreadId) {
      await navigate({
        to: "/$threadId",
        params: { threadId: targetThreadId },
      });
    }

    return targetThreadId;
  }, [
    activeDraftThread?.projectId,
    activeDraftThread?.worktreePath,
    activeProjectId,
    activeServerThread,
    activeThreadId,
    activeThreadBranch,
    activeWorkspaceBranch,
    getDraftThreadByProjectId,
    navigate,
    setProjectDraftThreadId,
  ]);

  const persistThreadWorkspaceContext = useCallback(
    async (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) {
        return;
      }

      const api = readNativeApi();
      if (api && hasServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }

      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }

      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(activeThreadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      activeWorktreePath,
      effectiveEnvMode,
      hasServerThread,
      setDraftThreadContext,
      setThreadBranchAction,
    ],
  );

  const closeDedicatedWorkspace = useCallback(
    async (discardChanges: boolean) => {
      if (!workspaceCwd || isPrimaryWorkspace || !repoCwd || !repoRoot || !activeThreadId) {
        return;
      }

      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Workspace controls unavailable",
          data: threadToastData,
        });
        return;
      }

      if (discardChanges) {
        const confirmed = await api.dialogs.confirm(
          [
            "Discard uncommitted changes and close this workspace?",
            formatWorktreePathForDisplay(workspaceCwd),
            "",
            "Committed branch history will be kept.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      if (activeServerThread?.session && activeServerThread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: repoCwd,
          path: workspaceCwd,
          force: discardChanges,
        });

        let nextPrimaryBranch = activeThreadBranch ?? activeWorkspaceBranch ?? null;
        let branchActivatedInPrimary = false;
        if (nextPrimaryBranch) {
          try {
            await api.git.checkout({ cwd: repoRoot, branch: nextPrimaryBranch });
            branchActivatedInPrimary = true;
          } catch {
            const fallbackPrimaryStatus = await api.git.status({ cwd: repoRoot }).catch(() => null);
            nextPrimaryBranch = fallbackPrimaryStatus?.branch ?? nextPrimaryBranch;
          }
        }

        await invalidateGitQueries(queryClient);
        await persistThreadWorkspaceContext(activeThreadBranch ?? activeWorkspaceBranch ?? null, null);
        toastManager.add({
          type: branchActivatedInPrimary || !activeThreadBranch ? "success" : "warning",
          title: discardChanges ? "Workspace discarded" : "Workspace closed",
          description:
            branchActivatedInPrimary && nextPrimaryBranch
              ? `Branch ${nextPrimaryBranch} is active in the primary checkout.`
              : activeThreadBranch
                ? `Branch ${activeThreadBranch} is released. Clean the primary checkout before switching to it.`
                : "The primary checkout is active again.",
          data: threadToastData,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: discardChanges ? "Failed to discard workspace" : "Failed to close workspace",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: threadToastData,
        });
      }
    },
    [
      activeServerThread?.session,
      activeThreadBranch,
      activeThreadId,
      activeWorkspaceBranch,
      isPrimaryWorkspace,
      persistThreadWorkspaceContext,
      queryClient,
      removeWorktreeMutation,
      repoCwd,
      repoRoot,
      threadToastData,
      workspaceCwd,
    ],
  );

  const runMergeFromBranch = useCallback(async (sourceBranch: string) => {
    if (!activeWorkspaceBranch || !sourceBranch) {
      return;
    }

    try {
      const result = await mergeBranchesMutation.mutateAsync({
        sourceBranch,
        targetBranch: activeWorkspaceBranch,
      });
      setLastMergeResult(result);
      toastManager.add({
        type: result.status === "merged" ? "success" : "warning",
        title:
          result.status === "merged"
            ? `Merged ${result.sourceBranch}`
            : `Conflicts in merge`,
        description:
          result.status === "merged"
            ? `Into ${result.targetBranch}`
            : `${result.conflictedFiles.length} file${result.conflictedFiles.length === 1 ? "" : "s"}`,
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Merge failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [activeWorkspaceBranch, mergeBranchesMutation, threadToastData]);

  const runLocalMerge = useCallback(async () => {
    if (!mergeSourceBranch) {
      return;
    }
    await runMergeFromBranch(mergeSourceBranch);
  }, [mergeSourceBranch, runMergeFromBranch]);

  const abortActiveMerge = useCallback(async () => {
    if (!workspaceCwd) {
      return;
    }

    try {
      const result = await abortMergeMutation.mutateAsync(workspaceCwd);
      if (result.status === "aborted") {
        setLastMergeResult(null);
      }
      toastManager.add({
        type: result.status === "aborted" ? "success" : "info",
        title: result.status === "aborted" ? "Merge aborted" : "No merge in progress",
        data: threadToastData,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to abort",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      });
    }
  }, [abortMergeMutation, threadToastData, workspaceCwd]);

  const createResolveConflictDraft = useCallback(() => {
    if (!activeThreadId || activeWorkspaceMerge.conflictedFiles.length === 0) {
      return;
    }
    const prompt = buildResolveConflictPrompt({
      workspacePath: workspaceCwd,
      sourceBranch: activeWorkspaceBranch,
      mergeSourceBranch:
        lastMergeResult?.sourceBranch ?? (mergeSourceBranch || activeTargetBranch || null),
      conflictedFiles: activeWorkspaceMerge.conflictedFiles,
    });
    setPrompt(activeThreadId, prompt);
    toastManager.add({
      type: "success",
      title: "Conflict resolution draft created",
      description: "The composer is prefilled with the current merge facts.",
      data: threadToastData,
    });
  }, [
    activeTargetBranch,
    activeThreadId,
    activeWorkspaceBranch,
    activeWorkspaceMerge.conflictedFiles,
    lastMergeResult?.sourceBranch,
    mergeSourceBranch,
    setPrompt,
    threadToastData,
    workspaceCwd,
  ]);

  const openPrimaryWorkspaceResolutionDraft = useCallback(async () => {
    if (!repoRoot) {
      return;
    }
    const targetThreadId = await focusPrimaryWorkspaceDraft();
    if (!targetThreadId) {
      return;
    }
    setPrompt(
      targetThreadId,
      buildPrimaryWorkspaceResolutionPrompt({
        workspacePath: repoRoot,
        takeoverBranch: activeThreadBranch ?? activeWorkspaceBranch ?? null,
        conflictedFiles: primaryWorkspaceStatus?.merge.conflictedFiles ?? [],
        changedFiles: primaryWorkspaceStatus?.workingTree.files.map((file) => file.path) ?? [],
      }),
    );
    toastManager.add({
      type: "success",
      title: "Primary checkout opened",
      description: "The composer is prefilled with the blocking checkout details.",
      data: threadToastData,
    });
  }, [
    activeThreadBranch,
    activeWorkspaceBranch,
    focusPrimaryWorkspaceDraft,
    primaryWorkspaceStatus?.merge.conflictedFiles,
    primaryWorkspaceStatus?.workingTree.files,
    repoRoot,
    setPrompt,
    threadToastData,
  ]);

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
      targetBranch,
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
      targetBranch?: string;
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
        ...(targetBranch ? { targetBranch } : {}),
      });
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running...",
          timeout: 0,
          data: threadToastData,
        });

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running...",
          timeout: 0,
          data: threadToastData,
        });
      }

      let stageIndex = 0;
      const stageInterval = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, progressStages.length - 1);
        toastManager.update(resolvedProgressToastId, {
          title: progressStages[stageIndex] ?? "Running...",
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
        ...(targetBranch ? { targetBranch } : {}),
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

  const runPromoteAction = useCallback(() => {
    if (!activeTargetBranch) return;
    setIsPromoteDialogOpen(false);
    void runGitActionWithToast({
      action: "promote",
      targetBranch: activeTargetBranch,
    });
  }, [activeTargetBranch, runGitActionWithToast]);

  const openExternalUrl = useCallback(
    async (url: string) => {
      const api = readNativeApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link unavailable",
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

  const verifyGitHubAuth = useCallback(async () => {
    const result = await githubStatusQuery.refetch();

    if (result.error) {
      toastManager.add({
        type: "error",
        title: "Verification failed",
        description: result.error.message,
        data: threadToastData,
      });
      return;
    }

    if (!result.data?.installed) {
      toastManager.add({
        type: "warning",
        title: "gh not installed",
        description: "Install GitHub CLI to enable features",
        data: threadToastData,
      });
      return;
    }

    if (!result.data.authenticated) {
      toastManager.add({
        type: "warning",
        title: "gh not authenticated",
        description: "Run auth flow to connect",
        data: threadToastData,
      });
      return;
    }

    toastManager.add({
      type: "success",
      title: "GitHub verified",
      description: result.data.accountLogin ? `@${result.data.accountLogin}` : undefined,
      data: threadToastData,
    });
  }, [githubStatusQuery, threadToastData]);

  const commitItem = gitActionMenuItems.find((item) => item.id === "commit") ?? null;
  const prItem = gitActionMenuItems.find((item) => item.id === "pr") ?? null;
  const githubRepoUrl = githubStatusQuery.data?.repo?.url ?? null;
  const issuesDisabled =
    githubIssuesQuery.error?.message.toLowerCase().includes("disabled issues") ?? false;
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
  const createWorktreeDisabledReason = !isPrimaryWorkspace
    ? null
    : !activeProjectId
      ? "No project context"
      : !gitStatusForActions
        ? "Status unavailable"
        : !repoCwd || !activeWorkspaceBranch
          ? "Checkout branch first"
          : gitStatusForActions.hasWorkingTreeChanges
            ? "Commit changes first"
            : createWorktreeMutation.isPending
              ? "Creating..."
              : null;
  const mergeDisabledReason = !gitStatusForActions
    ? "Status unavailable"
    : !activeWorkspaceBranch
      ? "Checkout branch first"
      : mergeSourceBranch.length === 0
        ? "No branches to merge"
        : activeWorkspaceHasConflicts
          ? "Resolve conflicts first"
          : activeWorkspaceMerge.inProgress
            ? "Finish current merge"
            : gitStatusForActions.hasWorkingTreeChanges
              ? "Commit changes first"
              : isMergeRunning
                ? "Merging..."
                : null;
  const syncFromTargetDisabledReason = !activeTargetBranch
    ? "No target branch"
    : activeTargetBranch === activeWorkspaceBranch
      ? "Already on target branch"
      : !gitStatusForActions
        ? "Status unavailable"
        : !activeWorkspaceBranch
          ? "Checkout branch first"
          : activeWorkspaceHasConflicts
            ? "Resolve conflicts first"
            : activeWorkspaceMerge.inProgress
              ? "Finish current merge"
              : gitStatusForActions.hasWorkingTreeChanges
                ? "Commit changes first"
                : isMergeRunning
                  ? "Merging..."
                  : null;
  const commitToBranchDisabledReason = resolveCommitToBranchDisabledReason({
    gitStatus: gitStatusForActions,
    hasConflicts: activeWorkspaceHasConflicts,
    isBusy: isGitActionRunning,
  });
  const dedicatedWorkspaceActionState = resolveDedicatedWorkspaceActionState({
    gitStatus: gitStatusForActions,
    hasConflicts: activeWorkspaceHasConflicts,
    mergeInProgress: activeWorkspaceMerge.inProgress,
    isClosing: removeWorktreeMutation.isPending,
    hasRepoContext: repoCwd !== null,
    hasThreadContext: activeThreadId !== null,
  });
  const primaryWorkspaceNeedsAttention =
    (primaryWorkspaceStatus?.merge.conflictedFiles.length ?? 0) > 0 ||
    primaryWorkspaceStatus?.merge.inProgress === true ||
    primaryWorkspaceStatus?.hasWorkingTreeChanges === true;

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
                <StatusDot level="success" className="mr-0.5" />
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
                  (githubStatusQuery.isFetching || githubIssuesQuery.isFetching) && "animate-spin"
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
              <Section title="Workspace">
                <WorkspaceCard
                  isPrimary={isPrimaryWorkspace}
                  name={
                    isPrimaryWorkspace || !workspaceCwd
                      ? "Primary checkout"
                      : formatWorktreePathForDisplay(workspaceCwd)
                  }
                  branch={activeWorkspaceBranch ?? "Detached HEAD"}
                  targetBranch={activeTargetBranch}
                  path={workspaceCwd}
                  statusLevel={statusInfo.level}
                  statusLabel={statusInfo.label}
                  aheadCount={gitStatusForActions?.aheadCount ?? 0}
                  behindCount={gitStatusForActions?.behindCount ?? 0}
                  hasOpenPr={gitStatusForActions?.pr?.state === "open"}
                  isDefaultBranch={activeWorkspaceBranchMeta?.isDefault ?? false}
                  onOpen={() => openPathInEditor(workspaceCwd)}
                />
                {/* Create dedicated workspace - only show in primary */}
                {isPrimaryWorkspace && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={createWorktreeDisabledReason !== null}
                    onClick={() => void createDedicatedWorkspace()}
                    className="w-full justify-start"
                  >
                    <FolderGit2Icon className="size-4" />
                    Create dedicated workspace
                    {createWorktreeDisabledReason && (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {createWorktreeDisabledReason}
                      </span>
                    )}
                  </Button>
                )}
                {!isPrimaryWorkspace && (
                  <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                    <Button
                      variant="default"
                      size="sm"
                      disabled={commitToBranchDisabledReason !== null}
                      onClick={() => {
                        if (commitItem) {
                          openDialogForMenuItem(commitItem);
                        }
                      }}
                      className="w-full justify-center"
                    >
                      <GitCommitIcon className="size-4" />
                      {buildCommitToBranchLabel(activeThreadBranch ?? activeWorkspaceBranch ?? null)}
                    </Button>
                    {commitToBranchDisabledReason && (
                      <p className="text-center text-xs text-muted-foreground">
                        {commitToBranchDisabledReason}
                      </p>
                    )}
                    {activeTargetBranch && activeTargetBranch !== activeWorkspaceBranch && (
                      <div className="space-y-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={syncFromTargetDisabledReason !== null}
                          onClick={() => {
                            void runMergeFromBranch(activeTargetBranch);
                          }}
                          className="w-full justify-center"
                        >
                          <DownloadIcon className="size-4" />
                          Sync from {activeTargetBranch}
                        </Button>
                        {syncFromTargetDisabledReason ? (
                          <p className="text-center text-xs text-muted-foreground">
                            {syncFromTargetDisabledReason}
                          </p>
                        ) : (
                          <p className="text-center text-xs text-muted-foreground">
                            Merge the target branch into this workspace before closing it.
                          </p>
                        )}
                      </div>
                    )}
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={dedicatedWorkspaceActionState.closeDisabledReason !== null}
                        onClick={() => {
                          void closeDedicatedWorkspace(false);
                        }}
                        className="w-full justify-center"
                      >
                        <FolderGit2Icon className="size-4" />
                        Close workspace
                      </Button>
                      {dedicatedWorkspaceActionState.showDiscardAction && (
                        <Button
                          variant="destructive-outline"
                          size="sm"
                          disabled={dedicatedWorkspaceActionState.discardDisabledReason !== null}
                          onClick={() => {
                            void closeDedicatedWorkspace(true);
                          }}
                          className="w-full justify-center"
                        >
                          Discard changes and close
                        </Button>
                      )}
                    </div>
                    {primaryWorkspaceNeedsAttention && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void openPrimaryWorkspaceResolutionDraft();
                        }}
                        className="w-full justify-center"
                      >
                        Prepare primary checkout
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {dedicatedWorkspaceActionState.closeDisabledReason ??
                        "Close the dedicated checkout once changes are committed to the branch."}
                    </p>
                    {primaryWorkspaceStatusError && (
                      <p className="text-xs text-destructive-foreground">
                        {primaryWorkspaceStatusError.message}
                      </p>
                    )}
                  </div>
                )}
              </Section>
            )}

            {/* ============================================================ */}
            {/* SYNC SECTION - Pull changes INTO this workspace */}
            {/* ============================================================ */}
            {isRepo && localBranches.length > 1 && (
              <Section title="Sync" collapsible defaultOpen={mergeExpanded}>
                <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">
                    Pull a branch <span className="font-medium">into</span> this workspace
                  </p>

                  <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                    <label className="space-y-1 text-xs">
                      <span className="text-muted-foreground">From branch</span>
                      <select
                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={mergeSourceBranch}
                        onChange={(e) => setMergeSourceBranch(e.target.value)}
                        disabled={localBranches.length < 2}
                      >
                        {mergeSourceBranch.length === 0 && (
                          <option value="">No candidates</option>
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
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mergeDisabledReason !== null}
                      onClick={() => void runLocalMerge()}
                    >
                      <DownloadIcon className="size-4" />
                      {isMergeRunning ? "Syncing..." : "Sync"}
                    </Button>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{mergeSourceBranch || "..."}</span>
                    <ArrowRightIcon className="size-3" />
                    <span className="font-mono font-medium">{activeWorkspaceBranch ?? "..."}</span>
                  </div>

                  {mergeDisabledReason && (
                    <p className="text-xs text-muted-foreground">{mergeDisabledReason}</p>
                  )}

                  {/* Conflict indicator */}
                  {activeWorkspaceHasConflicts && (
                    <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/[0.04] p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-destructive-foreground">
                          {activeWorkspaceMerge.conflictedFiles.length} conflicted file
                          {activeWorkspaceMerge.conflictedFiles.length === 1 ? "" : "s"}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!activeThreadId}
                            onClick={createResolveConflictDraft}
                          >
                            Resolve conflict
                          </Button>
                          <Button
                            variant="destructive-outline"
                            size="xs"
                            disabled={isAbortMergeRunning}
                            onClick={() => void abortActiveMerge()}
                          >
                            Abort
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {activeWorkspaceMerge.conflictedFiles.map((file) => (
                          <Badge key={file} variant="outline" size="sm">
                            {file}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Last merge result */}
                  {lastMergeResult && !activeWorkspaceHasConflicts && (
                    <div
                      className={cn(
                        "rounded-md border p-2 text-xs",
                        lastMergeResult.status === "merged"
                          ? "border-success/30 bg-success/[0.04] text-success-foreground"
                          : "border-destructive/30 bg-destructive/[0.04] text-destructive-foreground"
                      )}
                    >
                      {lastMergeResult.status === "merged"
                        ? `Merged ${lastMergeResult.sourceBranch} → ${lastMergeResult.targetBranch}`
                        : `Conflicts merging ${lastMergeResult.sourceBranch}`}
                    </div>
                  )}
                </div>
              </Section>
            )}

            {/* ============================================================ */}
            {/* GITHUB AUTH SECTION */}
            {/* ============================================================ */}
            <Section
              title="GitHub"
              actions={
                githubStatusQuery.data?.accountLogin && (
                  <Badge variant="outline" size="sm">
                    @{githubStatusQuery.data.accountLogin}
                  </Badge>
                )
              }
            >
              {!githubStatusQuery.data?.installed ? (
                <p className="text-xs text-muted-foreground">
                  Install <code className="rounded bg-muted px-1">gh</code> CLI to enable GitHub features
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={
                      isGitHubAuthenticated ? githubStatusQuery.isFetching : loginMutation.isPending
                    }
                    onClick={() => {
                      if (isGitHubAuthenticated) {
                        void verifyGitHubAuth();
                        return;
                      }
                      loginMutation.mutate();
                    }}
                  >
                    <LogInIcon className="size-3.5" />
                    {isGitHubAuthenticated
                      ? githubStatusQuery.isFetching
                        ? "Verifying..."
                        : "Verify"
                      : loginMutation.isPending
                        ? "Authenticating..."
                        : "Authenticate"}
                  </Button>
                  {githubRepoUrl && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void openExternalUrl(githubRepoUrl)}
                    >
                      <ExternalLinkIcon className="size-3.5" />
                      Open repo
                    </Button>
                  )}
                  {loginMutation.error && (
                    <span className="text-xs text-destructive-foreground">
                      {loginMutation.error.message}
                    </span>
                  )}
                </div>
              )}
            </Section>

            {/* ============================================================ */}
            {/* ISSUES SECTION */}
            {/* ============================================================ */}
            {githubStatusQuery.data?.authenticated && githubStatusQuery.data?.repo && (
              <Section
                title="Issues"
                collapsible
                defaultOpen={false}
                actions={
                  <div className="flex gap-0.5">
                    {(["open", "closed", "all"] as const).map((state) => (
                      <Button
                        key={state}
                        variant={issueState === state ? "secondary" : "ghost"}
                        size="xs"
                        onClick={() => setIssueState(state)}
                        className="h-5 px-1.5 text-[10px]"
                      >
                        {state.charAt(0).toUpperCase() + state.slice(1)}
                      </Button>
                    ))}
                  </div>
                }
              >
                {githubIssuesQuery.isLoading || githubIssuesQuery.isFetching ? (
                  <p className="text-xs text-muted-foreground">Loading...</p>
                ) : issuesDisabled ? (
                  <p className="text-xs text-muted-foreground">Issues disabled for this repo</p>
                ) : githubIssuesQuery.error ? (
                  <p className="text-xs text-destructive-foreground">
                    {githubIssuesQuery.error.message}
                  </p>
                ) : githubIssuesQuery.data && githubIssuesQuery.data.issues.length > 0 ? (
                  <div className="space-y-1">
                    {githubIssuesQuery.data.issues.map((issue) => (
                      <button
                        type="button"
                        key={issue.number}
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
                        onClick={() => void openExternalUrl(issue.url)}
                      >
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          #{issue.number}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{issue.title}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {issue.author && <span>@{issue.author}</span>}
                            <span>{formatGitHubTimestamp(issue.updatedAt)}</span>
                          </div>
                        </div>
                        <StatusDot
                          level={issue.state === "open" ? "success" : "neutral"}
                          className="mt-1.5"
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No issues</p>
                )}
              </Section>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* ================================================================== */}
      {/* COMMIT DIALOG */}
      {/* ================================================================== */}
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
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Branch</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">
                    {gitStatusForActions?.branch ?? "(detached)"}
                  </span>
                  {isDefaultBranch && (
                    <Badge variant="warning" size="sm">
                      default
                    </Badge>
                  )}
                </div>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground">Files</p>
                {!gitStatusForActions || gitStatusForActions.workingTree.files.length === 0 ? (
                  <p className="font-medium">No changes</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-40 rounded-md border border-input bg-background">
                      <div className="space-y-0.5 p-1">
                        {gitStatusForActions.workingTree.files.map((file) => (
                          <button
                            type="button"
                            key={file.path}
                            className="flex w-full items-center justify-between gap-3 rounded px-2 py-1 font-mono text-left transition-colors hover:bg-accent/50"
                            onClick={() => openChangedFileInEditor(file.path)}
                          >
                            <span className="truncate">{file.path}</span>
                            <span className="shrink-0 tabular-nums">
                              <span className="text-success-foreground">+{file.insertions}</span>
                              <span className="mx-0.5 text-border">/</span>
                              <span className="text-destructive-foreground">-{file.deletions}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono tabular-nums">
                      <span className="text-success-foreground">
                        +{gitStatusForActions.workingTree.insertions}
                      </span>
                      <span className="mx-1 text-border">/</span>
                      <span className="text-destructive-foreground">
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
              New branch
            </Button>
            <Button size="sm" onClick={runDialogAction}>
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* ================================================================== */}
      {/* DEFAULT BRANCH CONFIRMATION DIALOG */}
      {/* ================================================================== */}
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
              {pendingDefaultBranchActionCopy?.title ?? "Continue on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDefaultBranchAction(null)}>
              Cancel
            </Button>
            <Button variant="outline" size="sm" onClick={continuePendingDefaultBranchAction}>
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            <Button size="sm" onClick={checkoutFeatureBranchAndContinuePendingAction}>
              Feature branch
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* ================================================================== */}
      {/* PROMOTE CONFIRMATION DIALOG */}
      {/* ================================================================== */}
      <Dialog
        open={isPromoteDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsPromoteDialogOpen(false);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Promote to {activeTargetBranch ?? "target"}?</DialogTitle>
            <DialogDescription>
              This will merge{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">
                {activeWorkspaceBranch ?? "current branch"}
              </code>{" "}
              into{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">
                {activeTargetBranch ?? "target"}
              </code>
              , push, and delete the feature branch. This bypasses pull request review.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <GitBranchIcon className="size-4 text-muted-foreground" />
              <span className="font-mono">{activeWorkspaceBranch}</span>
              <ArrowRightIcon className="size-4 text-muted-foreground" />
              <span className="font-mono font-medium">{activeTargetBranch}</span>
            </div>
            {gitStatusForActions?.hasWorkingTreeChanges && (
              <p className="text-xs text-muted-foreground">
                Uncommitted changes will be committed first.
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsPromoteDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={runPromoteAction}>
              Promote
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
