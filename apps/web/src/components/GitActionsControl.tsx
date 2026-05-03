import { type ScopedThreadRef } from "@t3tools/contracts";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, CloudUploadIcon, GitCommitIcon, InfoIcon } from "lucide-react";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { newCommandId, randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readEnvironmentApi } from "~/environmentApi";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useStore } from "~/store";
import { createThreadSelectorByRef } from "~/storeSelectors";
import { resolveVcsActionPresentation, resolveVcsTerms } from "~/vcsPresentation";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return "Git action in progress.";
  if (!gitStatus) return "Git status is unavailable.";

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;

  if (item.id === "commit") {
    if (!hasChanges) {
      return "Worktree is clean. Make changes before committing.";
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return "Detached HEAD: checkout a refName before pushing.";
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return "Branch is behind upstream. Pull/rebase before pushing.";
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return `View ${terminology.singular} is currently unavailable.`;
  }
  if (!hasBranch) {
    return `Detached HEAD: checkout a refName before creating a ${terminology.singular}.`;
  }
  if (hasChanges) {
    return `Commit local changes before creating a ${terminology.singular}.`;
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if (!isAhead) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (isBehind) {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.singular} is currently unavailable.`;
}

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <SourceControlIcon />;
}

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
}: {
  quickAction: GitQuickAction;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <SourceControlIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <InfoIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <SourceControlIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

export default function GitActionsControl({
  gitCwd,
  activeThreadRef,
  draftId,
}: GitActionsControlProps) {
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const activeServerThreadSelector = useMemo(
    () => createThreadSelectorByRef(activeThreadRef),
    [activeThreadRef],
  );
  const activeServerThread = useStore(activeServerThreadSelector);
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const queryClient = useQueryClient();
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        const worktreePath = activeServerThread.worktreePath;
        const api = readEnvironmentApi(activeThreadRef.environmentId);
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: activeThreadRef.threadId,
              branch,
              worktreePath,
            })
            .catch(() => undefined);
        }

        setThreadBranch(activeThreadRef, branch, worktreePath);
        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      setThreadBranch,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  const { data: gitStatus = null, error: gitStatusError } = useGitStatus({
    environmentId: activeEnvironmentId,
    cwd: gitCwd,
  });
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const vcsKind = gitStatus?.kind ?? null;
  const vcsTerms = resolveVcsTerms(vcsKind);
  const vcsActionPresentation = resolveVcsActionPresentation(vcsKind);
  const supportsGitWorkflowActions = !isRepo || vcsActionPresentation.supportsGitWorkflowActions;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = supportsGitWorkflowActions ? gitStatus : null;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initMutation = useMutation(
    gitInitMutationOptions({ environmentId: activeEnvironmentId, cwd: gitCwd, queryClient }),
  );

  const runImmediateGitActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      environmentId: activeEnvironmentId,
      cwd: gitCwd,
      queryClient,
    }),
  );
  const pullMutation = useMutation(
    gitPullMutationOptions({ environmentId: activeEnvironmentId, cwd: gitCwd, queryClient }),
  );

  const isRunStackedActionRunning =
    useIsMutating({
      mutationKey: gitMutationKeys.runStackedAction(activeEnvironmentId, gitCwd),
    }) > 0;
  const isPullRunning =
    useIsMutating({ mutationKey: gitMutationKeys.pull(activeEnvironmentId, gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeServerThread?.branch ?? activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread?.branch,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isSelectingWorktreeBase,
    persistThreadBranchSync,
  ]);

  const isDefaultRef = useMemo(() => {
    return gitStatusForActions?.isDefaultRef ?? false;
  }, [gitStatusForActions?.isDefaultRef]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.branchName,
        includesCommit: pendingDefaultBranchAction.includesCommit,
        terminology: changeRequestTerminology,
      })
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  useEffect(() => {
    if (gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        void refreshGitStatus({ environmentId: activeEnvironmentId, cwd: gitCwd }).catch(
          () => undefined,
        );
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd]);

  const openExistingPr = useCallback(async () => {
    const api = readLocalApi();
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
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    void api.shell.openExternal(prUrl).catch((err: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: err instanceof Error ? err.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatusForActions, threadToastData]);

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.refName ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the rejected mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const promise = runImmediateGitActionMutation.mutateAsync({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });

      try {
        const result = await promise;
        activeGitActionProgressRef.current = null;
        syncThreadBranchAfterGitAction(result);
        const closeResultToast = () => {
          toastManager.close(resolvedProgressToastId);
        };

        const toastCta = result.toast.cta;
        let toastActionProps: {
          children: string;
          onClick: () => void;
        } | null = null;
        if (toastCta.kind === "run_action") {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              closeResultToast();
              void runGitActionWithToast({
                action: toastCta.action.kind,
              });
            },
          };
        } else if (toastCta.kind === "open_pr") {
          toastActionProps = {
            children: toastCta.label,
            onClick: () => {
              const api = readLocalApi();
              if (!api) return;
              closeResultToast();
              void api.shell.openExternal(toastCta.url);
            },
          };
        }

        const successToastData = {
          ...scopedToastData,
          dismissAfterVisibleMs: 10_000,
        };

        if (toastActionProps) {
          toastManager.update(
            resolvedProgressToastId,
            stackedThreadToast({
              type: "success",
              title: result.toast.title,
              description: result.toast.description,
              timeout: 0,
              actionProps: toastActionProps,
              actionVariant: "outline",
              data: successToastData,
            }),
          );
        } else {
          toastManager.update(resolvedProgressToastId, {
            type: "success",
            title: result.toast.title,
            description: result.toast.description,
            timeout: 0,
            data: successToastData,
          });
        }
      } catch (err) {
        activeGitActionProgressRef.current = null;
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: err instanceof Error ? err.message : "An error occurred.",
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
      }
    },
  );

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      const promise = pullMutation.mutateAsync();
      void toastManager.promise<
        Awaited<ReturnType<typeof pullMutation.mutateAsync>>,
        ThreadToastData
      >(promise, {
        loading: { title: "Pulling...", data: threadToastData },
        success: (result) => ({
          title: result.status === "pulled" ? "Pulled" : "Already up to date",
          description:
            result.status === "pulled"
              ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`
              : `${result.refName} is already synchronized.`,
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
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api || !gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void openInPreferredEditor(api, target).catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      });
    },
    [gitCwd, threadToastData],
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
      ) : !supportsGitWorkflowActions ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                aria-disabled="true"
                className="cursor-not-allowed opacity-70"
                size="xs"
                variant="outline"
              />
            }
          >
            {vcsTerms.systemName} {vcsTerms.repositoryNoun}
          </PopoverTrigger>
          <PopoverPopup tooltipStyle side="bottom" align="end">
            {vcsActionPresentation.unsupportedGitWorkflowDescription}
          </PopoverPopup>
        </Popover>
      ) : (
        <Group aria-label="Git actions" className="shrink-0">
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
                <GitQuickActionIcon
                  quickAction={quickAction}
                  SourceControlIcon={SourceControlIcon}
                />
                <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                  {quickAction.label}
                </span>
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
              <GitQuickActionIcon quickAction={quickAction} SourceControlIcon={SourceControlIcon} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                {quickAction.label}
              </span>
            </Button>
          )}
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu
            onOpenChange={(open) => {
              if (open) {
                void refreshGitStatus({
                  environmentId: activeEnvironmentId,
                  cwd: gitCwd,
                }).catch(() => undefined);
              }
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
                const disabledReason = getMenuActionDisabledReason({
                  item,
                  gitStatus: gitStatusForActions,
                  isBusy: isGitActionRunning,
                  hasPrimaryRemote,
                });
                if (item.disabled && disabledReason) {
                  return (
                    <Popover key={`${item.id}-${item.label}`}>
                      <PopoverTrigger
                        openOnHover
                        nativeButton={false}
                        render={<span className="block w-max cursor-not-allowed" />}
                      >
                        <MenuItem className="w-full" disabled>
                          <GitActionItemIcon
                            icon={item.icon}
                            SourceControlIcon={SourceControlIcon}
                          />
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
                    <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                    {item.label}
                  </MenuItem>
                );
              })}
              {gitStatusForActions?.refName === null && (
                <p className="px-2 py-1.5 text-xs text-warning">
                  Detached HEAD: create and checkout a refName to enable push and pull request
                  actions.
                </p>
              )}
              {gitStatusForActions &&
                gitStatusForActions.refName !== null &&
                !gitStatusForActions.hasWorkingTreeChanges &&
                gitStatusForActions.behindCount > 0 &&
                gitStatusForActions.aheadCount === 0 && (
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
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
            setExcludedFiles(new Set());
            setIsEditingFiles(false);
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
                  <span className="font-medium">
                    {gitStatusForActions?.refName ?? "(detached HEAD)"}
                  </span>
                  {isDefaultRef && (
                    <span className="text-right text-warning text-xs">
                      Warning: default refName
                    </span>
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setExcludedFiles(
                            allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">Files</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setIsEditingFiles((prev) => !prev)}
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-md border border-input bg-background">
                      <div className="space-y-1 p-1">
                        {allFiles.map((file) => {
                          const isExcluded = excludedFiles.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono text-xs transition-colors hover:bg-accent/50"
                            >
                              {isEditingFiles && (
                                <Checkbox
                                  checked={!excludedFiles.has(file.path)}
                                  onCheckedChange={() => {
                                    setExcludedFiles((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(file.path)) {
                                        next.delete(file.path);
                                      } else {
                                        next.add(file.path);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                className="flex flex-1 items-center justify-between gap-3 text-left truncate"
                                onClick={() => openChangedFileInEditor(file.path)}
                              >
                                <span
                                  className={`truncate${isExcluded ? " text-muted-foreground" : ""}`}
                                >
                                  {file.path}
                                </span>
                                <span className="shrink-0">
                                  {isExcluded ? (
                                    <span className="text-muted-foreground">Excluded</span>
                                  ) : (
                                    <>
                                      <span className="text-success">+{file.insertions}</span>
                                      <span className="text-muted-foreground"> / </span>
                                      <span className="text-destructive">-{file.deletions}</span>
                                    </>
                                  )}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono">
                      <span className="text-success">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
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
                setExcludedFiles(new Set());
                setIsEditingFiles(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new refName
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
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
