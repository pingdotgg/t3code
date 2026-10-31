import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useDeadlinePassed } from "../hooks/useDeadline";
import { useNowSecond } from "../hooks/useNowSecond";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type GitRunStackedActionResult,
  type GitStackedAction,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { type MouseEvent, type ReactNode, useEffect, useEffectEvent, useState } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  EllipsisIcon,
  BookUp2Icon,
  CheckIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  FileDiffIcon,
  GitBranchPlusIcon,
  GitCommitHorizontalIcon,
  GitCommitIcon,
  InfoIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import {
  buildMenuItems,
  buildSyncMenuItems,
  formatGitActionElapsed,
  GIT_ACTION_SUCCESS_VISIBLE_MS,
  gitStackedActionTitle,
  type GitActionProgressPresentation,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveChangesTotals,
  resolveDefaultBranchActionDialogCopy,
  resolveFeatureBranchUnavailableReason,
  resolveGitActionProgressPresentation,
  resolveGitActionResultToastTiming,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { GitCommitDialog, type GitCommitDialogSubmission } from "./GitCommitDialog";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useVcsInitAction,
  useVcsPullAction,
} from "../state/sourceControlActions";
import { useQuietThreadProjection, useQuietThreadShell } from "~/state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsActionManager, vcsEnvironment, vcsStatusRevalidation } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";

interface GitActionsControlProps {
  /** "shortcut" keeps the commit and push shortcut and its dialogs live. */
  presentation?: "shortcut";
  displayMode?: "panel";
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  compact?: boolean;
  listenForShortcuts?: boolean;
  showActions?: boolean;
  showChanges?: boolean;
  onOpenChanges?: () => void;
  keybindings?: ResolvedKeybindingsConfig;
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

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

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
      return "Detached HEAD: check out a branch before pushing.";
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

  if (!hasBranch) {
    return `Detached HEAD: check out a branch before creating a ${terminology.singular}.`;
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (isBehind) {
    return `Branch is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.singular} is currently unavailable.`;
}

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
  className = "size-3.5",
}: {
  quickAction: GitQuickAction;
  className?: string;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={className} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={className} />;
    }
    return <SourceControlIcon className={className} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={className} />;
  if (quickAction.label === "Push") return <CloudUploadIcon className={className} />;
  return <InfoIcon className={className} />;
}

function GitActionElapsedTime({
  startedAtMs,
  className,
}: {
  startedAtMs: number | null;
  className?: string;
}) {
  return startedAtMs === null ? null : (
    <GitActionElapsedTimeLabel startedAtMs={startedAtMs} className={className} />
  );
}

function GitActionElapsedTimeLabel({
  startedAtMs,
  className,
}: {
  startedAtMs: number;
  className: string | undefined;
}) {
  const nowMs = useNowSecond();
  const elapsed = formatGitActionElapsed(startedAtMs, nowMs);
  if (!elapsed) {
    return null;
  }

  return <p className={className}>{elapsed}</p>;
}

function GitActionProgressButtonContent({ progress }: { progress: GitActionProgressPresentation }) {
  const hasOutput = progress.output !== null;

  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className={cn(
        "grid min-w-0 flex-1 items-center",
        "grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.5rem] gap-x-3",
      )}
      role="status"
    >
      <Spinner aria-hidden="true" className="row-start-1 -mx-0.5 shrink-0" />
      <p className={cn("row-start-1 min-w-0 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {progress.status}
      </p>
      <div
        className={cn(
          "col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          hasOutput ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-caption text-muted-foreground" />
              }
            >
              {progress.output}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {progress.output}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function GitActionSuccessButtonContent({ success }: { success: InlineGitActionSuccess }) {
  const hasDescription = success.description !== null;

  return (
    <div
      aria-live="polite"
      className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.5rem] items-center gap-x-3"
      role="status"
    >
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success-foreground" />
      <p className={cn("min-w-0 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {success.title}
      </p>
      <div
        className={cn(
          "col-start-2 grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          hasDescription ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <Tooltip>
            <TooltipTrigger
              render={
                <p className="truncate pt-0.5 text-left text-caption text-muted-foreground" />
              }
            >
              {success.description}
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-96 break-words">
              {success.description}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

export default function GitActionsControl({
  presentation,
  listenForShortcuts = true,
  displayMode,
  gitCwd,
  activeThreadRef,
  draftId,
  showActions = true,
  showChanges = true,
  onOpenChanges,
  keybindings: panelKeybindings,
}: GitActionsControlProps) {
  const isPanel = presentation !== "shortcut";
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
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = activeThreadRef ? { threadRef: activeThreadRef } : undefined;
  const activeServerThreadShell = useQuietThreadShell(activeThreadRef);
  const openPrLink = useOpenPrLink(activeThreadRef ?? undefined);
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

  // Changed-file paths resolve against the worktree root from this status snapshot.
  const workingTreeRoot = gitStatusForActions?.workingTree.rootPath ?? null;
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
  const syncMenuItems = buildSyncMenuItems(
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
          title: `${gitStackedActionTitle(action, changeRequestTerminology)} failed`,
          description: error instanceof Error ? error.message : "An error occurred.",
          timeout: errorToastTiming.timeout,
          ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
        }),
      );
      return;
    }

    const actionResult = result.value;
    syncThreadBranchAfterGitAction(actionResult);
    if (isPanel) {
      const createdPullRequest = actionResult.pr.status === "created";
      setInlineSuccess({
        title: createdPullRequest
          ? `Created ${changeRequestTerminology.shortLabel}`
          : actionResult.toast.title,
        description: createdPullRequest ? null : (actionResult.toast.description ?? null),
        scopeKey: successScopeKey,
        expiresAtMs: inlineSuccessExpiresAt(),
      });
      return;
    }
    let resultToastId: GitActionToastId | null = null;
    const closeResultToast = () => {
      if (resultToastId !== null) {
        toastManager.close(resultToastId);
      }
    };

    const toastCta = actionResult.toast.cta;
    let toastActionProps: {
      children: string;
      onClick: (event: MouseEvent<HTMLButtonElement>) => void;
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
        onClick: (event) => {
          closeResultToast();
          openPrLink(event, toastCta.url);
        },
      };
    }

    const successToastTiming = resolveGitActionResultToastTiming("success");
    const successToastData = {
      ...scopedToastData,
      ...(successToastTiming.dismissAfterVisibleMs !== null
        ? { dismissAfterVisibleMs: successToastTiming.dismissAfterVisibleMs }
        : {}),
    };

    if (toastActionProps) {
      resultToastId = toastManager.add(
        stackedThreadToast({
          type: "success",
          title: actionResult.toast.title,
          description: actionResult.toast.description,
          timeout: successToastTiming.timeout,
          actionProps: toastActionProps,
          data: successToastData,
        }),
      );
    } else {
      resultToastId = toastManager.add({
        type: "success",
        title: actionResult.toast.title,
        description: actionResult.toast.description,
        timeout: successToastTiming.timeout,
        data: successToastData,
      });
    }
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

  const runPull = () => {
    if (!canWriteSourceControl) return;
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
      if (isPanel) {
        setInlineSuccess({
          title,
          description,
          scopeKey: successScopeKey,
          expiresAtMs: inlineSuccessExpiresAt(),
        });
        return;
      }
      const successToastTiming = resolveGitActionResultToastTiming("success");
      toastManager.add({
        type: "success",
        title,
        description,
        timeout: successToastTiming.timeout,
        data: {
          ...threadToastData,
          ...(successToastTiming.dismissAfterVisibleMs !== null
            ? { dismissAfterVisibleMs: successToastTiming.dismissAfterVisibleMs }
            : {}),
        },
      });
    })();
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_publish") {
      setIsPublishDialogOpen(true);
      return;
    }
    if (quickAction.kind === "run_pull") {
      runPull();
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

  const runCommitPush = () => {
    if (!syncMenuItems.commitPush || syncMenuItems.commitPush.disabled) return;
    void runGitActionWithToast({ action: "commit_push" });
  };

  // Sync ref pulls what upstream has, then pushes what the branch still has ahead.
  const runSync = () => {
    if (!syncMenuItems.sync || syncMenuItems.sync.disabled || !gitStatusForActions) return;
    if (gitStatusForActions.behindCount > 0) {
      runPull();
      return;
    }
    void runGitActionWithToast({ action: "push" });
  };

  const runCommitPushFromShortcut = useEffectEvent(runCommitPush);
  const handlesCommitPushShortcut = presentation === "shortcut" && isRepo;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for the mounted git control's commit and push shortcuts
  useEffect(() => {
    if (!listenForShortcuts || !handlesCommitPushShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "git.commitPush") return;
      event.preventDefault();
      runCommitPushFromShortcut();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlesCommitPushShortcut, keybindings, listenForShortcuts]);

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (!canWriteSourceControl || item.disabled) return;
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    setIsCommitDialogOpen(true);
  };

  const runCommitDialog = (submission: GitCommitDialogSubmission) => {
    setIsCommitDialogOpen(false);
    void runGitActionWithToast({
      action: "commit",
      ...(submission.commitMessage ? { commitMessage: submission.commitMessage } : {}),
      ...(submission.filePaths ? { filePaths: [...submission.filePaths] } : {}),
      ...(submission.featureBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
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
  const commitPushShortcutLabel = shortcutLabelForCommand(keybindings, "git.commitPush");
  const changedFileCount = gitStatusForActions?.workingTree.files.length ?? 0;
  const menuDensity = "default";
  const renderMenuRow = (row: {
    readonly key: string;
    readonly icon: ReactNode;
    readonly label: string;
    readonly disabled: boolean;
    readonly disabledReason: string | null;
    readonly trailing?: ReactNode;
    readonly onClick: () => void;
  }) => (
    <div key={row.key}>
      <MenuItem
        density={menuDensity}
        disabled={!canWriteSourceControl || row.disabled}
        onClick={row.onClick}
      >
        {row.icon}
        <MenuItemLabel>{row.label}</MenuItemLabel>
        {row.trailing}
      </MenuItem>
      {row.disabled && row.disabledReason ? (
        <p className="max-w-72 ps-8 pe-2 pb-1.5 text-meta text-dim-foreground">
          {row.disabledReason}
        </p>
      ) : null}
    </div>
  );
  const renderActionMenuItem = (item: GitActionMenuItem) =>
    renderMenuRow({
      key: `${item.id}-${item.label}`,
      icon:
        item.icon === "commit" ? (
          <GitCommitHorizontalIcon />
        ) : item.icon === "push" ? (
          <CloudUploadIcon />
        ) : (
          <SourceControlIcon />
        ),
      label: item.label,
      disabled: !canWriteSourceControl || item.disabled,
      disabledReason: getMenuActionDisabledReason({
        item,
        gitStatus: gitStatusForActions,
        isBusy: isGitActionRunning,
        hasPrimaryRemote,
      }),
      ...(item.id === "commit" && changedFileCount > 0
        ? {
            trailing: (
              <span className="ms-auto ps-3 text-meta text-dim-foreground tabular-nums">
                {changedFileCount} {changedFileCount === 1 ? "file" : "files"}
              </span>
            ),
          }
        : {}),
      onClick: () => openDialogForMenuItem(item),
    });
  const commitItem = gitActionMenuItems.find((item) => item.id === "commit");
  const pushItem = gitActionMenuItems.find((item) => item.id === "push");
  const prItem = gitActionMenuItems.find((item) => item.id === "pr");
  const gitItems = (
    <>
      <MenuGroup>
        <MenuGroupLabel>Git actions</MenuGroupLabel>
        {commitItem ? renderActionMenuItem(commitItem) : null}
        {syncMenuItems.commitPush
          ? renderMenuRow({
              key: "commit_push",
              icon: <UploadIcon />,
              label: syncMenuItems.commitPush.label,
              disabled: syncMenuItems.commitPush.disabled,
              disabledReason: syncMenuItems.commitPush.disabledReason,
              ...(commitPushShortcutLabel
                ? { trailing: <MenuShortcut>{commitPushShortcutLabel}</MenuShortcut> }
                : {}),
              onClick: runCommitPush,
            })
          : null}
        {pushItem ? renderActionMenuItem(pushItem) : null}
        {syncMenuItems.pull
          ? renderMenuRow({
              key: "pull",
              icon: <ArrowDownToLineIcon />,
              label: syncMenuItems.pull.label,
              disabled: syncMenuItems.pull.disabled,
              disabledReason: syncMenuItems.pull.disabledReason,
              onClick: () => runPull(),
            })
          : null}
        {prItem ? renderActionMenuItem(prItem) : null}
        {syncMenuItems.sync
          ? renderMenuRow({
              key: "sync",
              icon: <RefreshCwIcon />,
              label: syncMenuItems.sync.label,
              disabled: syncMenuItems.sync.disabled,
              disabledReason: syncMenuItems.sync.disabledReason,
              onClick: runSync,
            })
          : null}
      </MenuGroup>
      {gitStatusForActions?.refName === null && (
        <p className="px-2 py-1.5 text-meta text-warning-foreground">
          Detached HEAD: create and check out a branch to enable push and{" "}
          {changeRequestTerminology.singular} actions.
        </p>
      )}
      {gitStatusError && (
        <p className="px-2 py-1.5 text-meta text-destructive-foreground">{gitStatusError}</p>
      )}
      {canPublishRepository ? (
        <>
          <MenuSeparator />
          <MenuItem
            density={menuDensity}
            disabled={isGitActionRunning}
            onClick={() => {
              setIsPublishDialogOpen(true);
            }}
          >
            <BookUp2Icon />
            <MenuItemLabel>Publish repository...</MenuItemLabel>
          </MenuItem>
        </>
      ) : null}
    </>
  );

  const changesSummary = (
    <span className="ms-auto flex shrink-0 items-center gap-1 text-caption tabular-nums">
      <span className="text-diff-addition">+{formatDiffCount(changesTotals?.insertions ?? 0)}</span>
      <span className="text-diff-deletion">-{formatDiffCount(changesTotals?.deletions ?? 0)}</span>
    </span>
  );

  const panelQuickAction = (
    <ThreadDetailsControl
      aria-disabled={quickActionDisabledReason ? "true" : undefined}
      disabled={
        !quickActionDisabledReason &&
        (!canWriteSourceControl || isGitActionRunning || quickAction.disabled)
      }
      onClick={quickActionDisabledReason ? undefined : runQuickAction}
    >
      <GitQuickActionIcon
        className="size-4"
        quickAction={quickAction}
        SourceControlIcon={SourceControlIcon}
      />
      <MenuItemLabel>{quickAction.label}</MenuItemLabel>
      {showChanges ? changesSummary : null}
    </ThreadDetailsControl>
  );

  if (!gitCwd) return null;

  return (
    <>
      {presentation === "shortcut" ? null : displayMode === "panel" && isRepo ? (
        <div className="flex shrink-0 items-center pe-1" role="group" aria-label="Git actions">
          {showActions ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    part="icon"
                    aria-label="Push branch"
                    disabled={
                      !canWriteSourceControl || isGitActionRunning || !pushItem || pushItem.disabled
                    }
                    onClick={() => void runGitActionWithToast({ action: "push" })}
                  />
                }
              >
                {gitActionProgress ? <Spinner size="xs" /> : <ArrowUpFromLineIcon />}
              </TooltipTrigger>
              <TooltipPopup>{"Push branch"}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Menu
            onOpenChange={(open) => {
              if (open) requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
            }}
          >
            <MenuTrigger
              render={<ThreadDetailsControl part="icon" aria-label="Git action options" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup side="bottom" align="end">
              {showChanges ? (
                <MenuItem disabled={!onOpenChanges} onClick={onOpenChanges}>
                  <FileDiffIcon />
                  <MenuItemLabel>View changes</MenuItemLabel>
                  {changesSummary}
                </MenuItem>
              ) : null}
              {showActions ? gitItems : null}
            </MenuPopup>
          </Menu>
        </div>
      ) : !isRepo ? (
        showActions ? (
          <ThreadDetailsControl
            disabled={!canWriteSourceControl || initAction.isPending}
            onClick={initializeGit}
          >
            <GitBranchPlusIcon aria-hidden />
            <MenuItemLabel>
              {initAction.isPending ? "Initializing..." : "Initialize Git"}
            </MenuItemLabel>
          </ThreadDetailsControl>
        ) : null
      ) : !showActions && (!showChanges || quietEmptyDraft) ? null : (
        <div role="group" aria-label="Git actions">
          {!showActions || quietEmptyDraft ? null : gitActionProgress ? (
            <div className="flex items-start">
              <ThreadDetailsControl
                className="flex-1"
                multiline
                disabled
                aria-label={
                  gitActionProgress.output
                    ? `${gitActionProgress.status} ${gitActionProgress.output}`
                    : gitActionProgress.status
                }
              >
                <GitActionProgressButtonContent progress={gitActionProgress} />
              </ThreadDetailsControl>
              <GitActionElapsedTime
                startedAtMs={gitActionProgress.startedAtMs}
                className="flex min-h-7 shrink-0 items-center pe-2 text-caption tabular-nums text-dim-foreground"
              />
            </div>
          ) : visibleInlineSuccess ? (
            <ThreadDetailsControl multiline disabled>
              <GitActionSuccessButtonContent success={visibleInlineSuccess} />
            </ThreadDetailsControl>
          ) : quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger openOnHover render={panelQuickAction} />
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            panelQuickAction
          )}
          {!showChanges || quietEmptyDraft ? null : (
            <ThreadDetailsControl disabled={!onOpenChanges} onClick={onOpenChanges}>
              <FileDiffIcon aria-hidden />
              <MenuItemLabel>View changes</MenuItemLabel>
              {!showActions ? changesSummary : null}
              {keybindings && (
                <MenuShortcut>
                  {shortcutLabelForCommand(panelKeybindings ?? keybindings, "diff.toggle")}
                </MenuShortcut>
              )}
            </ThreadDetailsControl>
          )}
          {showActions ? (
            <Menu
              onOpenChange={(open) => {
                if (open) requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }}
            >
              <MenuTrigger
                disabled={isGitActionRunning}
                render={<ThreadDetailsControl part="choice" aria-label="Git action options" />}
              >
                <SourceControlIcon />
                <MenuItemLabel>Git actions</MenuItemLabel>
              </MenuTrigger>
              <MenuPopup side="right" align="start">
                {gitItems}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      )}

      <GitCommitDialog
        open={isCommitDialogOpen}
        onOpenChange={setIsCommitDialogOpen}
        gitStatus={gitStatusForActions}
        isDefaultRef={isDefaultRef}
        canWriteSourceControl={canWriteSourceControl}
        canChangeThreadBranch={canChangeThreadBranch}
        canOpenFiles={canOperateThread && workingTreeRoot !== null}
        onOpenFile={openChangedFileInEditor}
        onSubmit={runCommitDialog}
      />

      {showActions ? (
        <PublishRepositoryDialog
          open={isPublishDialogOpen}
          onOpenChange={setIsPublishDialogOpen}
          environmentId={activeEnvironmentId}
          threadRef={activeThreadRef}
          gitCwd={gitCwd}
        />
      ) : null}

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDefaultBranchAction(null);
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
            {featureBranchUnavailableReason && (
              <p className="text-caption text-muted-foreground">{featureBranchUnavailableReason}</p>
            )}
          </DialogHeader>
          <DialogFooter variant="bare" className="sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="secondary"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              Abort
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              variant="secondary"
              size="sm-multiline"
              onClick={() => continuePendingDefaultBranchAction(false)}
              disabled={!canWriteSourceControl}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              size="sm-multiline"
              onClick={() => continuePendingDefaultBranchAction(true)}
              disabled={!canChangeThreadBranch || featureBranchUnavailableReason !== null}
            >
              Check out feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
