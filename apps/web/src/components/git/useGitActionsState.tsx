import type { GitActionsControlProps } from "./gitActionsTypes";

import { useAtomCommand } from "~/state/use-atom-command";
import { threadEnvironment } from "~/state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "~/state/server";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useEffect, useEffectEvent, useState } from "react";
import { vcsActionManager, vcsEnvironment, vcsStatusRevalidation } from "~/state/vcs";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { buildMenuItems, GIT_ACTION_SUCCESS_VISIBLE_MS, type GitActionIconName, type GitActionMenuItem, type DefaultBranchConfirmableAction, requiresDefaultBranchConfirmation, resolveChangesTotals, resolveDefaultBranchActionDialogCopy, resolveFeatureBranchUnavailableReason, resolveGitActionProgressPresentation, resolveGitActionResultToastTiming, resolveLiveThreadBranchUpdate, resolveThreadBranchMetadataPatch, resolveQuickAction, resolveThreadBranchUpdate } from "../GitActionsControl.logic";
import type { GitRunStackedActionResult, GitStackedAction, VcsStatusResult } from "@t3tools/contracts";
import { useEnvironmentQuery } from "~/state/query";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsInitAction,
  useVcsPullAction,
  type SourceControlActionState,
} from "../../state/sourceControlActions";
import { randomUUID } from "~/lib/utils";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { getMenuActionDisabledReason } from "../GitActionsControlParts";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { MenuItem, MenuItemLabel } from "~/components/ui/menu";
import { CloudUploadIcon, GitCommitIcon } from "lucide-react";

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  filePaths?: string[];
}

interface InlineGitActionSuccess {
  readonly title: string;
  readonly description: string | null;
  readonly scopeKey: string;
  readonly expiresAtMs: number;
}

const inlineSuccessExpiresAt = () => Date.now() + GIT_ACTION_SUCCESS_VISIBLE_MS;

const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

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

export function useGitActionsState(props: GitActionsControlProps) {
  const { activeThreadRef, gitCwd, draftId } = props;
    const updateThreadMetadata = useAtomCommand(
      threadEnvironment.updateMetadata,
      "thread branch metadata update",
    );
    const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
    const successScopeKey = `${activeEnvironmentId ?? ""}\u0000${gitCwd ?? ""}`;
    const canWriteSourceControl = useEnvironmentScope(
      activeEnvironmentId,
      AuthSourceControlWriteScope,
    );
    const canOperateThread = useEnvironmentScope(activeEnvironmentId, AuthOrchestrationOperateScope);
    const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
    const openInPreferredEditor = useOpenInPreferredEditor(
      activeEnvironmentId,
      serverConfig?.availableEditors ?? [],
    );
    const threadToastData = activeThreadRef ? { threadRef: activeThreadRef } : undefined;
    const activeServerThreadShell = useQuietThreadShell(activeThreadRef);
    const activeDraftThread = useComposerDraftStore((store) =>
      draftId
        ? store.getDraftSession(draftId)
        : activeThreadRef
          ? store.getDraftThreadByRef(activeThreadRef)
          : null,
    );
    const activeServerThreadProjection = useQuietThreadProjection(
      activeDraftThread !== null && activeServerThreadShell === null ? null : activeThreadRef,
    );
    const activeServerThread =
      activeServerThreadShell ?? activeServerThreadProjection?.projection.thread ?? null;
    const isLocalDraftThread = activeDraftThread !== null && activeServerThread === null;
    const canChangeThreadBranch = canWriteSourceControl && (isLocalDraftThread || canOperateThread);
    const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
    const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
    const [dialogCommitMessage, setDialogCommitMessage] = useState("");
    const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
    const [isEditingFiles, setIsEditingFiles] = useState(false);
    const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
    const [inlineSuccess, setInlineSuccess] = useState<InlineGitActionSuccess | null>(null);
    const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
      useState<PendingDefaultBranchAction | null>(null);
    const sourceControlScope = { environmentId: activeEnvironmentId, cwd: gitCwd };
    const vcsActionState = useAtomValue(vcsActionManager.stateAtom(sourceControlScope));
    const inlineSuccessExpired = useDeadlinePassed(inlineSuccess?.expiresAtMs ?? null);
    const visibleInlineSuccess =
      inlineSuccess?.scopeKey === successScopeKey && !inlineSuccessExpired ? inlineSuccess : null;

    const persistThreadBranchSync = (branch: string | null, manualSelection = false) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (
          !readEnvironmentScope(activeThreadRef.environmentId, AuthOrchestrationOperateScope) ||
          activeServerThread.branch === branch
        ) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
        environmentSelection: manualSelection
          ? "manual"
          : (activeDraftThread.environmentSelection ??
            (activeDraftThread.branch ? "manual" : "auto")),
      });
    };
    const persistLiveThreadBranch = useEffectEvent((branch: string | null) => {
      persistThreadBranchSync(branch);
    });

    const syncThreadBranchAfterGitAction = (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch, true);
    };

    const gitStatusQuery = useEnvironmentQuery(
      activeEnvironmentId !== null && gitCwd !== null
        ? vcsEnvironment.status({
            environmentId: activeEnvironmentId,
            input: { cwd: gitCwd },
          })
        : null,
    );
    const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
      reportFailure: false,
    });
    const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
    const sourceControlPresentation = getSourceControlPresentation(gitStatus?.sourceControlProvider);
    const changeRequestTerminology = sourceControlPresentation.terminology;
    const SourceControlIcon = sourceControlPresentation.Icon;
    const isRepo = gitStatus?.isRepo ?? true;
    const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
    const gitStatusForActions = gitStatus;
    const changesTotals = resolveChangesTotals(gitStatusForActions) ?? {
      insertions: 0,
      deletions: 0,
    };

    const allFiles = gitStatusForActions?.workingTree.files ?? [];
    // Changed-file paths are repository-relative, so they must resolve against
    // the worktree root from the same status snapshot, not the project cwd.
    const workingTreeRoot = gitStatusForActions?.workingTree.rootPath ?? null;
    const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
    const allSelected = excludedFiles.size === 0;
    const noneSelected = selectedFiles.length === 0;

    const initAction = useVcsInitAction(sourceControlScope);
    const runImmediateGitAction = useGitStackedAction(sourceControlScope);
    const pullAction = useVcsPullAction(sourceControlScope);
    const isGitActionRunning = useSourceControlActionRunning(
      sourceControlScope,
      RUNNING_SOURCE_CONTROL_ACTIONS,
    );
    const isSelectingWorktreeBase =
      !activeServerThread &&
      activeDraftThread?.envMode === "worktree" &&
      activeDraftThread.worktreePath === null;

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the draft thread branch when the live git status subscription reports a different branch
    useEffect(() => {
      if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread) {
        return;
      }

      const branchUpdate = resolveLiveThreadBranchUpdate({
        threadBranch: activeDraftThread?.branch ?? null,
        gitStatus: gitStatusForActions,
      });
      if (!branchUpdate) {
        return;
      }

      persistLiveThreadBranch(branchUpdate.branch);
    }, [
      activeServerThread,
      activeDraftThread?.branch,
      gitStatusForActions,
      isGitActionRunning,
      isSelectingWorktreeBase,
    ]);

    const isDefaultRef = gitStatusForActions?.isDefaultRef ?? false;

    const gitActionMenuItems = buildMenuItems(
      gitStatusForActions,
      isGitActionRunning,
      hasPrimaryRemote,
    );
    const quickAction = resolveQuickAction(
      gitStatusForActions,
      isGitActionRunning,
      isDefaultRef,
      hasPrimaryRemote,
    );
    const quickActionDisabledReason = !canWriteSourceControl
      ? "This connection cannot change source control."
      : quickAction.disabled
        ? (quickAction.hint ?? "This action is currently unavailable.")
        : null;
    const gitActionProgress = resolveGitActionProgressPresentation(vcsActionState);
    // A fresh draft or a thread with no turns hides commit, push, and diff rows until there is work.
    const quietEmptyDraft =
      (draftId !== undefined || activeServerThreadShell?.latestRun === null) &&
      gitActionProgress === null &&
      !gitStatusError &&
      quickAction.disabled &&
      !changesTotals.insertions &&
      !changesTotals.deletions;
    const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
      ? resolveDefaultBranchActionDialogCopy({
          action: pendingDefaultBranchAction.action,
          branchName: pendingDefaultBranchAction.branchName,
          includesCommit: pendingDefaultBranchAction.includesCommit,
          terminology: changeRequestTerminology,
        })
      : null;
    // Keep enabled until live status loads; the server rejects stale requests.
    const featureBranchUnavailableReason = pendingDefaultBranchAction
      ? resolveFeatureBranchUnavailableReason({
          branchName: pendingDefaultBranchAction.branchName,
          hasWorkingTreeChanges: gitStatus?.hasWorkingTreeChanges ?? true,
        })
      : null;

    useAtomMount(
      vcsStatusRevalidation(
        activeEnvironmentId !== null && gitCwd !== null
          ? { environmentId: activeEnvironmentId, cwd: gitCwd }
          : null,
      ),
    );

    async function runGitActionWithToast({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      filePaths,
    }: RunGitActionWithToastInput) {
      if (
        activeEnvironmentId === null ||
        !readEnvironmentScope(activeEnvironmentId, AuthSourceControlWriteScope) ||
        (featureBranch &&
          !isLocalDraftThread &&
          !readEnvironmentScope(activeEnvironmentId, AuthOrchestrationOperateScope))
      )
        return;
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
      setInlineSuccess(null);

      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();

      const result = await runImmediateGitAction.run({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(activeServerThread ? { threadId: activeServerThread.id } : {}),
        ...(activeDraftThread ? { projectId: activeDraftThread.projectId } : {}),
      });

      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return;
        }

        const error = squashAtomCommandFailure(result);
        const errorToastTiming = resolveGitActionResultToastTiming("error");
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            timeout: errorToastTiming.timeout,
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
        return;
      }

      const actionResult = result.value;
      syncThreadBranchAfterGitAction(actionResult);
      const createdPullRequest = actionResult.pr.status === "created";
      setInlineSuccess({
        title: createdPullRequest
          ? `Created ${changeRequestTerminology.shortLabel}`
          : actionResult.toast.title,
        description: createdPullRequest ? null : (actionResult.toast.description ?? null),
        scopeKey: successScopeKey,
        expiresAtMs: inlineSuccessExpiresAt(),
      });
    }

    const continuePendingDefaultBranchAction = (featureBranch: boolean) => {
      if (!pendingDefaultBranchAction || !canWriteSourceControl) return;
      if (featureBranch && (!canChangeThreadBranch || featureBranchUnavailableReason !== null))
        return;
      const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
      setPendingDefaultBranchAction(null);
      void runGitActionWithToast({
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(onConfirmed ? { onConfirmed } : {}),
        ...(filePaths ? { filePaths } : {}),
        featureBranch,
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
      if (quickAction.kind === "open_publish") {
        setIsPublishDialogOpen(true);
        return;
      }
      if (quickAction.kind === "run_pull") {
        void (async () => {
          setInlineSuccess(null);
          const result = await pullAction.run();
          if (result._tag === "Failure") {
            if (isAtomCommandInterrupted(result)) {
              return;
            }
            const error = squashAtomCommandFailure(result);
            const errorToastTiming = resolveGitActionResultToastTiming("error");
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Pull failed",
                description: error instanceof Error ? error.message : "An error occurred.",
                timeout: errorToastTiming.timeout,
                ...(threadToastData !== undefined ? { data: threadToastData } : {}),
              }),
            );
            return;
          }

          const pullResult = result.value;
          const title = pullResult.status === "pulled" ? "Pulled" : "Already up to date";
          const description =
            pullResult.status === "pulled"
              ? `Updated ${pullResult.refName} from ${pullResult.upstreamRef ?? "upstream"}`
              : `${pullResult.refName} is already synchronized.`;
          setInlineSuccess({
            title,
            description,
            scopeKey: successScopeKey,
            expiresAtMs: inlineSuccessExpiresAt(),
          });
        })();
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

    const openChangedFileInEditor = (filePath: string) => {
      if (workingTreeRoot === null) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, workingTreeRoot);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    };

    const canPublishRepository =
      canWriteSourceControl && isRepo && gitStatusForActions !== null && !hasPrimaryRemote;

    const initializeGit = () => {
      void (async () => {
        const result = await initAction.run();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Git initialization failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    };
    const gitItems = (
      <>
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
                  render={<span className="block w-full cursor-not-allowed" />}
                >
                  <MenuItem className="w-full" disabled>
                    <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                    <MenuItemLabel>{item.label}</MenuItemLabel>
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
              disabled={!canWriteSourceControl || item.disabled}
              onClick={() => {
                openDialogForMenuItem(item);
              }}
            >
              <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
              <MenuItemLabel>{item.label}</MenuItemLabel>
            </MenuItem>
          );
        })}
        {canPublishRepository ? (
          <MenuItem
            disabled={isGitActionRunning}
            onClick={() => {
              setIsPublishDialogOpen(true);
            }}
          >
            <CloudUploadIcon />
            <MenuItemLabel>Publish repository...</MenuItemLabel>
          </MenuItem>
        ) : null}
        {gitStatusForActions?.refName === null && (
          <p className="px-2 py-1.5 text-xs text-warning">
            Detached HEAD: create and check out a branch to enable push and{" "}
            {changeRequestTerminology.singular} actions.
          </p>
        )}
        {gitStatusForActions &&
          gitStatusForActions.refName !== null &&
          !gitStatusForActions.hasWorkingTreeChanges &&
          gitStatusForActions.behindCount > 0 &&
          gitStatusForActions.aheadCount === 0 && (
            <p className="px-2 py-1.5 text-xs text-warning">Behind upstream. Pull/rebase first.</p>
          )}
        {gitStatusError && <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError}</p>}
      </>
    );

  return { activeEnvironmentId, canWriteSourceControl, canOperateThread, canChangeThreadBranch, isCommitDialogOpen, setIsCommitDialogOpen, dialogCommitMessage, setDialogCommitMessage, excludedFiles, setExcludedFiles, isEditingFiles, setIsEditingFiles, isPublishDialogOpen, setIsPublishDialogOpen, pendingDefaultBranchAction, setPendingDefaultBranchAction, visibleInlineSuccess, refreshVcsStatus, SourceControlIcon, isRepo, gitStatusForActions, changesTotals, allFiles, workingTreeRoot, selectedFiles, allSelected, noneSelected, initAction, isGitActionRunning, isDefaultRef, quickAction, quickActionDisabledReason, gitActionProgress, quietEmptyDraft, pendingDefaultBranchActionCopy, featureBranchUnavailableReason, continuePendingDefaultBranchAction, runDialogActionOnNewBranch, runQuickAction, runDialogAction, openChangedFileInEditor, initializeGit, gitItems };
}
