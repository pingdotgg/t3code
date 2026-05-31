import { type ScopedThreadRef } from "@t3tools/contracts";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readEnvironmentApi } from "~/environmentApi";
import {
  gitInitMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useStore } from "~/store";
import { createThreadSelectorByRef } from "~/storeSelectors";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import {
  buildGitActionProgressStages,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

type GitActionToastId = ReturnType<typeof toastManager.add>;
type GitActionToastMode = "progress-and-result" | "result-only" | "none";
type GitActionToastDescriptor = Parameters<typeof toastManager.add>[0];

export interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  onSuccess?: () => void;
  onSettled?: () => void;
  toastMode?: GitActionToastMode;
  filePaths?: string[];
}

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

export interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  onSuccess?: () => void;
  onSettled?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
  /**
   * When true, no loading/success progress toast is shown. The caller is
   * expected to surface progress inline (e.g. a button spinner). Failures are
   * still reported with an error toast.
   */
  suppressProgressToast?: boolean;
  toastMode?: GitActionToastMode;
}

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

function buildGitSuccessToastDescriptor({
  result,
  scopedToastData,
  closeResultToast,
  runToastAction,
}: {
  result: GitRunStackedActionResult;
  scopedToastData: ThreadToastData | undefined;
  closeResultToast: () => void;
  runToastAction: (action: GitStackedAction) => void;
}): GitActionToastDescriptor {
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
        runToastAction(toastCta.action.kind);
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
    return stackedThreadToast({
      type: "success",
      title: result.toast.title,
      description: result.toast.description,
      timeout: 0,
      actionProps: toastActionProps,
      data: successToastData,
    });
  }

  return {
    type: "success",
    title: result.toast.title,
    description: result.toast.description,
    timeout: 0,
    data: successToastData,
  };
}

export function useGitActionRunner({
  gitCwd,
  environmentId,
  activeThreadRef,
  draftId,
}: {
  gitCwd: string | null;
  environmentId: ScopedThreadRef["environmentId"] | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId | null;
}) {
  const activeEnvironmentId = environmentId ?? activeThreadRef?.environmentId ?? null;
  const queryClient = useQueryClient();
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
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  // True while we await the post-action status refresh. The mutation itself has
  // already settled by then, so this keeps action buttons in their loading
  // state until the fresh status lands and the UI can flip cleanly.
  const [isFinalizingAction, setIsFinalizingAction] = useState(false);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);

  const { data: gitStatus = null, error: gitStatusError } = useGitStatus({
    environmentId: activeEnvironmentId,
    cwd: gitCwd,
  });
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

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
  const isPublishRunning =
    useIsMutating({
      mutationKey: gitMutationKeys.publishRepository(activeEnvironmentId, gitCwd),
    }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning || isPublishRunning;

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
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
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
  }, [gitStatus, threadToastData]);

  const runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      onSuccess,
      onSettled,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
      suppressProgressToast = false,
      toastMode,
    }: RunGitActionWithToastInput) => {
      const resolvedToastMode: GitActionToastMode = suppressProgressToast
        ? "none"
        : (toastMode ?? "progress-and-result");
      const actionStatus = statusOverride ?? gitStatus;
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
          return false;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(onSuccess ? { onSuccess } : {}),
          ...(onSettled ? { onSettled } : {}),
          toastMode: resolvedToastMode,
          ...(filePaths ? { filePaths } : {}),
        });
        return false;
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
      const shouldUseProgressToast =
        progressToastId !== undefined || resolvedToastMode === "progress-and-result";
      const shouldShowResultToast = resolvedToastMode !== "none" || progressToastId !== undefined;
      const resolvedProgressToastId: GitActionToastId | null =
        progressToastId ??
        (shouldUseProgressToast
          ? toastManager.add({
              type: "loading",
              title: progressStages[0] ?? "Running git action...",
              description: "Waiting for Git...",
              timeout: 0,
              data: scopedToastData,
            })
          : null);

      activeGitActionProgressRef.current =
        resolvedProgressToastId === null
          ? null
          : {
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
            return;
          case "action_failed":
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
        if (gitCwd) {
          // Await a forced refresh so the action's promise only resolves once
          // the panel's status reflects the new state, letting buttons flip
          // cleanly without a stale flash.
          setIsFinalizingAction(true);
          try {
            await refreshGitStatus(
              { environmentId: activeEnvironmentId, cwd: gitCwd },
              { force: true },
            ).catch(() => undefined);
          } finally {
            setIsFinalizingAction(false);
          }
        }
        onSuccess?.();
        if (shouldShowResultToast) {
          let resultToastId = resolvedProgressToastId;
          const closeResultToast = () => {
            if (resultToastId) {
              toastManager.close(resultToastId);
            }
          };
          const successToast = buildGitSuccessToastDescriptor({
            result,
            scopedToastData,
            closeResultToast,
            runToastAction: (nextAction) => {
              void runGitActionWithToast({
                action: nextAction,
              });
            },
          });

          if (resolvedProgressToastId === null) {
            resultToastId = toastManager.add(successToast);
          } else {
            toastManager.update(resolvedProgressToastId, successToast);
          }
        }
        return true;
      } catch (err) {
        activeGitActionProgressRef.current = null;
        const errorToast = stackedThreadToast({
          type: "error",
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
        });
        if (resolvedProgressToastId === null) {
          toastManager.add(errorToast);
        } else {
          toastManager.update(resolvedProgressToastId, errorToast);
        }
        return false;
      } finally {
        onSettled?.();
      }
    },
  );

  const continuePendingDefaultBranchAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, onSuccess, onSettled, toastMode, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(onSuccess ? { onSuccess } : {}),
      ...(onSettled ? { onSettled } : {}),
      ...(toastMode ? { toastMode } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction]);

  const checkoutFeatureBranchAndContinuePendingAction = useCallback(() => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, onSuccess, onSettled, toastMode, filePaths } =
      pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(onSuccess ? { onSuccess } : {}),
      ...(onSettled ? { onSettled } : {}),
      ...(toastMode ? { toastMode } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  }, [pendingDefaultBranchAction]);

  const runPull = useCallback(() => {
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
  }, [pullMutation, threadToastData]);

  return {
    gitStatus,
    gitStatusError,
    isRepo,
    hasPrimaryRemote,
    isDefaultRef,
    isGitActionRunning,
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
  };
}
