import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react";
import { m } from "../i18n/messages";
import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";
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
import { type MouseEvent, type ReactNode, useEffect, useEffectEvent, useId, useState } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  EllipsisIcon,
  BookUp2Icon,
  CheckIcon,
  ChevronDownIcon,
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
  hasUsableGitMenuContent,
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
  getMenuActionDisabledReason,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { GitCommitDialog, type GitCommitDialogSubmission } from "./GitCommitDialog";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";
import { Button } from "~/components/ui/button";
import { Group, GroupSeparator } from "~/components/ui/group";
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
import { useProjectClone } from "~/state/projectClones";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useEnvironmentQuery } from "~/state/query";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { reviewEnvironment } from "~/state/review";
import { revisionedQuery } from "~/state/revisionedQuery";
import {
  selectThreadBranchBaseRef,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "~/diffPanelStore";
import { useClientSettings } from "~/hooks/useSettings";
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
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { PullRequestGlyph } from "./pullRequest/pullRequestIcons";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { ChangeBreakdownGrid } from "./pullRequest/ChangeBreakdownGrid";

interface GitActionsControlProps {
  /** "shortcut" keeps the commit and push shortcut and its dialogs live. */
  presentation?: "shortcut" | "toolbar";
  displayMode?: "panel";
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  compact?: boolean;
  listenForShortcuts?: boolean;
  showActions?: boolean;
  showChanges?: boolean;
  onOpenChanges?: () => void;
  workspaceMutationId?: string | null;
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

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
  className = "size-3.5",
}: {
  quickAction: GitQuickAction;
  className?: string;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  const messages = useMessages();
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={className} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={className} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={className} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={className} />;
    }
    return <SourceControlIcon className={className} />;
  }
  // show_hint carries no action, so match the label resolveQuickAction gave it.
  if (quickAction.label === messages(msg("Commit", { $context: "verb, git action" }))) {
    return <GitCommitIcon className={className} />;
  }
  if (quickAction.label === messages(msg("Push", { $context: "verb, git action" }))) {
    return <CloudUploadIcon className={className} />;
  }
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
  const messages = useMessages();
  const nowMs = useNowSecond();
  const elapsed = formatGitActionElapsed(startedAtMs, nowMs, messages);
  if (!elapsed) {
    return null;
  }

  return (
    <p aria-live="off" className={className}>
      {elapsed}
    </p>
  );
}

function GitActionProgressButtonContent({
  progress,
  id,
}: {
  progress: GitActionProgressPresentation;
  id: string;
}) {
  const hasOutput = progress.output !== null;

  return (
    <div
      id={id}
      aria-atomic="false"
      aria-live="polite"
      className={cn(
        "grid min-w-0 flex-1 items-center",
        "grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[1.125rem] gap-x-3",
      )}
      role="status"
    >
      <Spinner aria-hidden="true" className="row-start-1 -mx-0.5 shrink-0" />
      <p
        className={cn(
          "row-start-1 min-w-0 self-baseline truncate text-left",
          THREAD_DETAILS_PANEL_LABEL_CLASS,
        )}
      >
        {progress.status}
      </p>
      <GitActionElapsedTime
        startedAtMs={progress.startedAtMs}
        className="col-start-3 row-start-1 self-baseline text-caption tabular-nums text-dim-foreground"
      />
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
      className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[1.125rem] items-center gap-x-3"
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
  workspaceMutationId = null,
}: GitActionsControlProps) {
  const gt = useGT();
  const messages = useMessages();
  const progressLabelId = useId();
  const isPanel = presentation === undefined;
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
  const [failedCommitMessage, setFailedCommitMessage] = useState("");
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
  const SourceControlIcon =
    gitStatus?.sourceControlProvider?.kind === "gitcafe"
      ? PullRequestGlyph.pullRequest
      : sourceControlPresentation.Icon;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = gitStatus;
  const changesBaseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, activeThreadRef),
  );
  const ignoreWhitespaceSetting = useClientSettings((settings) => settings.diffIgnoreWhitespace);
  const ignoreWhitespace =
    useDiffPanelSessionStore((state) => state.ignoreWhitespace) ?? ignoreWhitespaceSetting;
  const { canReadFiles } = useFilesystemReadAccess(activeEnvironmentId, messages);
  // Same input as the Diff panel's branch query, so both read one cached result. Status
  // totals join the revision because edits, pulls and resets outside a turn leave the mutation
  // id as is.
  const changesRevision = gitStatusForActions
    ? JSON.stringify([
        workspaceMutationId,
        gitStatusForActions.refName,
        gitStatusForActions.workingTree.insertions,
        gitStatusForActions.workingTree.deletions,
        gitStatusForActions.branchChanges?.baseRef,
        gitStatusForActions.branchChanges?.insertions,
        gitStatusForActions.branchChanges?.deletions,
      ])
    : null;
  const changesPreview = useEnvironmentQuery(
    showChanges &&
      isRepo &&
      canReadFiles &&
      changesRevision !== null &&
      activeEnvironmentId !== null &&
      gitCwd !== null
      ? revisionedQuery(
          reviewEnvironment.diffPreview({
            environmentId: activeEnvironmentId,
            input: {
              cwd: gitCwd,
              ...(changesBaseRef ? { baseRef: changesBaseRef } : {}),
              ignoreWhitespace,
              metadataOnly: true,
              sourceKind: "branch-range",
            },
          }),
          changesRevision,
        )
      : null,
  );
  const resolvedChangesTotals = resolveChangesTotals(
    gitStatusForActions,
    changesPreview.data?.sources.find((source) => source.kind === "branch-range"),
  );
  const changesTotals = resolvedChangesTotals ?? { insertions: 0, deletions: 0 };
  const changesBreakdown = resolvedChangesTotals?.breakdown ?? null;
  const changesBaseLabel = resolvedChangesTotals
    ? resolvedChangesTotals.baseRef === null
      ? gt("Uncommitted")
      : gt("vs {ref}", { ref: resolvedChangesTotals.baseRef })
    : null;

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

  // Until a clone finishes, the status names an unborn HEAD that the repository may never have.
  const activeProjectClone = useProjectClone(
    activeDraftThread
      ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
      : null,
  );
  const isProjectCloning = activeProjectClone !== null && activeProjectClone.phase !== "done";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the draft thread branch when the live git status subscription reports a different branch
  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread || isProjectCloning) {
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
    isProjectCloning,
    isSelectingWorktreeBase,
  ]);

  const isDefaultRef = gitStatusForActions?.isDefaultRef ?? false;

  const gitActionMenuItems = buildMenuItems(
    gitStatusForActions,
    isGitActionRunning,
    hasPrimaryRemote,
    messages,
  );
  const syncMenuItems = buildSyncMenuItems(
    gitStatusForActions,
    isGitActionRunning,
    hasPrimaryRemote,
    messages,
  );
  const quickAction = resolveQuickAction(
    gitStatusForActions,
    isGitActionRunning,
    isDefaultRef,
    hasPrimaryRemote,
    messages,
  );
  const quickActionDisabledReason = !canWriteSourceControl
    ? gt("This connection cannot change source control.")
    : quickAction.disabled
      ? (quickAction.hint ?? gt("This action is currently unavailable."))
      : null;
  const gitActionProgress = resolveGitActionProgressPresentation(vcsActionState, messages);
  // A fresh draft or a thread with no turns hides commit, push, and diff rows until there is work.
  const quietEmptyDraft =
    (draftId !== undefined || activeServerThreadShell?.latestRun === null) &&
    gitActionProgress === null &&
    !gitStatusError &&
    quickAction.disabled &&
    !changesTotals.insertions &&
    !changesTotals.deletions;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy(
        {
          action: pendingDefaultBranchAction.action,
          branchName: pendingDefaultBranchAction.branchName,
          includesCommit: pendingDefaultBranchAction.includesCommit,
          terminology: changeRequestTerminology,
        },
        messages,
      )
    : null;
  // Keep enabled until live status loads; the server rejects stale requests.
  const featureBranchUnavailableReason = pendingDefaultBranchAction
    ? resolveFeatureBranchUnavailableReason(
        {
          action: pendingDefaultBranchAction.action,
          branchName: pendingDefaultBranchAction.branchName,
          hasWorkingTreeChanges: gitStatus?.hasWorkingTreeChanges ?? true,
        },
        messages,
      )
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
      return false;
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
        return false;
      }
      setPendingDefaultBranchAction({
        action,
        branchName: actionBranch,
        includesCommit,
        ...(commitMessage ? { commitMessage } : {}),
        ...(onConfirmed ? { onConfirmed } : {}),
        ...(filePaths ? { filePaths } : {}),
      });
      return false;
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
        return false;
      }

      const error = squashAtomCommandFailure(result);
      const errorToastTiming = resolveGitActionResultToastTiming("error");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("{action} failed", {
            action: gitStackedActionTitle(action, changeRequestTerminology, messages),
          }),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
          timeout: errorToastTiming.timeout,
          ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
        }),
      );
      return false;
    }

    const actionResult = result.value;
    syncThreadBranchAfterGitAction(actionResult);
    if (isPanel) {
      const createdPullRequest = actionResult.pr.status === "created";
      setInlineSuccess({
        title: createdPullRequest
          ? gt("Created {term, select, mr {MR} cr {change request} other {PR}}", {
              term: changeRequestTermKind(changeRequestTerminology),
            })
          : actionResult.toast.title,
        description: createdPullRequest ? null : (actionResult.toast.description ?? null),
        scopeKey: successScopeKey,
        expiresAtMs: inlineSuccessExpiresAt(),
      });
      return true;
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
    }
    return true;
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
            title: gt("Pull failed"),
            description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
            timeout: errorToastTiming.timeout,
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
        return;
      }

      const pullResult = result.value;
      const title = pullResult.status === "pulled" ? gt("Pulled") : gt("Already up to date");
      const description =
        pullResult.status === "pulled"
          ? pullResult.upstreamRef
            ? gt("Updated {ref} from {upstream}", {
                ref: pullResult.refName,
                upstream: pullResult.upstreamRef,
              })
            : gt("Updated {ref} from upstream", { ref: pullResult.refName })
          : gt("{ref} is already synchronized.", { ref: pullResult.refName });
      setInlineSuccess({
        title,
        description,
        scopeKey: successScopeKey,
        expiresAtMs: inlineSuccessExpiresAt(),
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
  const handlesCommitPushShortcut = presentation !== undefined && isRepo;
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
    setFailedCommitMessage("");
    const commitMessage = submission.commitMessage ?? "";
    void runGitActionWithToast({
      action: "commit",
      ...(submission.commitMessage ? { commitMessage: submission.commitMessage } : {}),
      ...(submission.filePaths ? { filePaths: [...submission.filePaths] } : {}),
      ...(submission.featureBranch ? { featureBranch: true, skipDefaultBranchPrompt: true } : {}),
    }).then((committed) => {
      // Keep a typed message for the retry unless the user already started a new one.
      if (committed || !commitMessage) return;
      setFailedCommitMessage((current) => current || commitMessage);
    });
  };

  const openChangedFileInEditor = (filePath: string) => {
    if (workingTreeRoot === null) {
      toastManager.add({
        type: "error",
        title: gt("Editor opening is unavailable."),
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
          title: gt("Unable to open file"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    })();
  };

  const canPublishRepository =
    canWriteSourceControl && isRepo && gitStatusForActions !== null && !hasPrimaryRemote;

  const isDetachedHead = gitStatusForActions?.refName === null;
  const isCleanAndBehind =
    gitStatusForActions !== null &&
    gitStatusForActions.refName !== null &&
    !gitStatusForActions.hasWorkingTreeChanges &&
    gitStatusForActions.behindCount > 0 &&
    gitStatusForActions.aheadCount === 0;
  const hasGitMenuContent =
    hasUsableGitMenuContent({
      menuItems: gitActionMenuItems,
      canWriteSourceControl,
      canPublishRepository,
      hasNotice: isDetachedHead || isCleanAndBehind || Boolean(gitStatusError),
    }) ||
    (canWriteSourceControl &&
      Object.values(syncMenuItems).some((item) => item !== null && !item.disabled));

  // A disabled menu cannot refresh on open, and terminal edits or commits publish no status.
  const refreshStatusForEmptyMenu = () =>
    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);

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
          title: gt("Git initialization failed"),
          description: thrownErrorMessage(error, m) ?? gt("An error occurred."),
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
  }) => {
    const disabled = !canWriteSourceControl || row.disabled;
    const item = (
      <MenuItem key={row.key} density={menuDensity} disabled={disabled} onClick={row.onClick}>
        {row.icon}
        <MenuItemLabel>{row.label}</MenuItemLabel>
        {row.trailing}
      </MenuItem>
    );
    return disabled && row.disabledReason ? (
      <Tooltip key={row.key}>
        <TooltipTrigger render={<span className="block" />}>{item}</TooltipTrigger>
        <TooltipPopup side="left">{row.disabledReason}</TooltipPopup>
      </Tooltip>
    ) : (
      item
    );
  };
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
      disabledReason: getMenuActionDisabledReason(
        {
          item,
          gitStatus: gitStatusForActions,
          isBusy: isGitActionRunning,
          hasPrimaryRemote,
        },
        messages,
      ),
      ...(item.id === "commit" && changedFileCount > 0
        ? {
            trailing: (
              <span className="ms-auto ps-3 text-meta text-dim-foreground tabular-nums">
                {gt("{count, plural, one {{count} file} other {{count} files}}", {
                  count: changedFileCount,
                })}
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
        <MenuGroupLabel>
          <T>Git actions</T>
        </MenuGroupLabel>
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
      {isDetachedHead && (
        <p className="px-2 py-1.5 text-meta text-warning-foreground">
          {gt(
            "Detached HEAD: create and check out a branch to enable push and {term, select, mr {merge request} cr {change request} other {pull request}} actions.",
            { term: changeRequestTermKind(changeRequestTerminology) },
          )}
        </p>
      )}
      {isCleanAndBehind && (
        <p className="px-2 py-1.5 text-meta text-warning-foreground">
          <T>Behind upstream. Pull/rebase first.</T>
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
            <MenuItemLabel>
              <T>Publish repository...</T>
            </MenuItemLabel>
          </MenuItem>
        </>
      ) : null}
    </>
  );

  const changesSummary = (
    <span className="ms-auto flex min-w-0 items-center gap-1 text-caption tabular-nums">
      {changesBaseLabel ? (
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate text-muted-foreground" />}>
            {changesBaseLabel}
          </TooltipTrigger>
          <TooltipPopup side="top">{changesBaseLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
      <span className="shrink-0 text-diff-addition">
        +{formatDiffCount(changesTotals?.insertions ?? 0)}
      </span>
      <span className="shrink-0 text-diff-deletion">
        -{formatDiffCount(changesTotals?.deletions ?? 0)}
      </span>
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
        showActions ? (
          <div
            className="col-start-2 flex shrink-0 items-center pe-1"
            role="group"
            aria-label={gt("Git actions")}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    part="icon"
                    aria-label={gt("Push branch")}
                    disabled={
                      !canWriteSourceControl || isGitActionRunning || !pushItem || pushItem.disabled
                    }
                    onClick={() => void runGitActionWithToast({ action: "push" })}
                  />
                }
              >
                {gitActionProgress ? <Spinner size="xs" /> : <ArrowUpFromLineIcon />}
              </TooltipTrigger>
              <TooltipPopup>
                <T>Push branch</T>
              </TooltipPopup>
            </Tooltip>
            <Menu
              onOpenChange={(open) => {
                if (open) requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuTrigger
                      render={
                        <ThreadDetailsControl part="icon" aria-label={gt("Git action options")} />
                      }
                    />
                  }
                >
                  <EllipsisIcon />
                </TooltipTrigger>
                <TooltipPopup>
                  <T>Git action options</T>
                </TooltipPopup>
              </Tooltip>
              <MenuPopup side="bottom" align="end" width="wide">
                {gitItems}
              </MenuPopup>
            </Menu>
          </div>
        ) : null
      ) : presentation === "toolbar" && isRepo ? (
        <Group aria-label={gt("Git actions")}>
          <Button
            size="sm"
            variant="secondary"
            disabled={
              !canWriteSourceControl ||
              isGitActionRunning ||
              quickAction.disabled ||
              Boolean(quickActionDisabledReason)
            }
            onClick={runQuickAction}
            aria-label={quickAction.label}
          >
            {quickAction.label}
          </Button>
          <GroupSeparator />
          <Menu
            onOpenChange={(open) => {
              if (open) requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="secondary"
                        aria-label={gt("Git action options")}
                        // Tooltip replaces the button data-slot, so toolbar theming needs a separate hook.
                        data-toolbar-control=""
                      />
                    }
                  />
                }
              >
                <ChevronDownIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <T>Git action options</T>
              </TooltipPopup>
            </Tooltip>
            <MenuPopup side="bottom" align="end">
              {gitItems}
            </MenuPopup>
          </Menu>
        </Group>
      ) : !isRepo ? (
        showActions ? (
          <ThreadDetailsControl
            disabled={!canWriteSourceControl || initAction.isPending}
            onClick={initializeGit}
          >
            <GitBranchPlusIcon aria-hidden />
            <MenuItemLabel>
              {initAction.isPending ? <T>Initializing...</T> : <T>Initialize Git</T>}
            </MenuItemLabel>
          </ThreadDetailsControl>
        ) : null
      ) : !showActions && (!showChanges || quietEmptyDraft) ? null : (
        <div
          role="group"
          aria-label={gt("Git actions")}
          onPointerEnter={hasGitMenuContent ? undefined : refreshStatusForEmptyMenu}
          onFocus={hasGitMenuContent ? undefined : refreshStatusForEmptyMenu}
        >
          {!showActions || quietEmptyDraft ? null : gitActionProgress ? (
            <ThreadDetailsControl
              className="flex-1"
              multiline
              disabled
              aria-labelledby={progressLabelId}
            >
              <GitActionProgressButtonContent id={progressLabelId} progress={gitActionProgress} />
            </ThreadDetailsControl>
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
          {showActions ? (
            <Menu
              onOpenChange={(open) => {
                if (open) requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }}
            >
              <MenuTrigger
                disabled={isGitActionRunning || !hasGitMenuContent}
                render={
                  <ThreadDetailsControl part="choice" aria-label={gt("Git action options")} />
                }
              >
                <SourceControlIcon />
                <MenuItemLabel>
                  <T>Git actions</T>
                </MenuItemLabel>
              </MenuTrigger>
              <MenuPopup
                side="right"
                align="start"
                collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
              >
                {gitItems}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      )}

      {isPanel && showChanges && isRepo && (displayMode === "panel" || !quietEmptyDraft) ? (
        <div className="col-span-2 min-w-0">
          <Tooltip>
            <TooltipTrigger
              render={<ThreadDetailsControl disabled={!onOpenChanges} onClick={onOpenChanges} />}
            >
              <FileDiffIcon aria-hidden />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0">
                  <T>Changes</T>
                </span>
                {changesBaseLabel ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="min-w-0 truncate text-muted-foreground" />}
                    >
                      {changesBaseLabel}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{changesBaseLabel}</TooltipPopup>
                  </Tooltip>
                ) : null}
                <span className="ms-auto flex shrink-0 items-baseline gap-2 ps-2 font-mono tabular-nums">
                  <span
                    className={
                      changesTotals?.insertions ? "text-diff-addition" : "text-muted-foreground"
                    }
                  >
                    +{formatDiffCount(changesTotals?.insertions ?? 0)}
                  </span>
                  <span
                    className={
                      changesTotals?.deletions ? "text-diff-deletion" : "text-muted-foreground"
                    }
                  >
                    -{formatDiffCount(changesTotals?.deletions ?? 0)}
                  </span>
                </span>
              </span>
            </TooltipTrigger>
            {changesBreakdown && (changesTotals.insertions > 0 || changesTotals.deletions > 0) ? (
              // Base UI fixes the popup width on open; remeasure when the breakdown changes.
              <TooltipPopup key={JSON.stringify(changesBreakdown)} side="bottom">
                <ChangeBreakdownGrid
                  breakdown={changesBreakdown}
                  total={{
                    additions: changesTotals.insertions,
                    deletions: changesTotals.deletions,
                  }}
                />
              </TooltipPopup>
            ) : null}
          </Tooltip>
        </div>
      ) : null}

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
        retainedMessage={failedCommitMessage}
      />

      {showActions ? (
        <PublishRepositoryDialog
          open={isPublishDialogOpen}
          onOpenChange={setIsPublishDialogOpen}
          environmentId={activeEnvironmentId}
          threadRef={activeThreadRef}
          gitCwd={gitCwd}
          offeredProviders={serverConfig?.settings.offeredSourceControlProviders}
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
              {pendingDefaultBranchActionCopy?.title ?? gt("Run action on default branch?")}
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
              <T>Abort</T>
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              variant="secondary"
              size="sm-multiline"
              onClick={() => continuePendingDefaultBranchAction(false)}
              disabled={!canWriteSourceControl}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? gt("Continue")}
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              size="sm-multiline"
              onClick={() => continuePendingDefaultBranchAction(true)}
              disabled={!canChangeThreadBranch || featureBranchUnavailableReason !== null}
            >
              <T>Check out feature branch & continue</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
