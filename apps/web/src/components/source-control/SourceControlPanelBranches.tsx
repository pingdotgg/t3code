import type {
  EnvironmentId,
  ThreadId,
  VcsPanelBranchDetails,
  VcsPanelCommitSummary,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitBranchPlus,
  GitCommit,
  GitMerge,
  GitPullRequestArrow,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

import { useTheme } from "~/hooks/useTheme";
import { getRenderablePatch, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import {
  isSourceControlPanelCommandInterrupted,
  resolveSourceControlPanelPresentationState,
  useSourceControlPanelApi,
} from "~/state/sourceControlPanel";
import { resolvePathLinkTarget } from "~/terminal-links";

import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import {
  type AttentionKind,
  type BranchSyncState,
  branchAttention,
  branchHasUpstream,
  branchIsCheckedOut,
  branchSyncCounts,
  branchSyncState,
  drainPanelRefreshQueue,
  namedBranchOperationCwd,
  type PanelChangedFile,
  stashIdentityKey,
} from "./SourceControlPanel.logic";
import {
  COMMIT_PAGE_SIZE,
  MIN_SECTION_WEIGHT,
  SECTION_TITLES,
  applyWorkingTreeFileEnrichment,
  commitUndoActionKey,
  enrichmentFileKey,
  expandedBranchesForSnapshot,
  fileBasename,
  isActionForced,
  localOnlyBranches,
  operationPathsForFile,
  shouldEnrichWorkingTreeFile,
  stashBranchName,
  sumFiles,
  treeKey,
  worktreeChangeSetId,
  commitCountLabel,
  type FileDiffSource,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";
import {
  AttentionIcon,
  BranchSyncActionIcon,
  BranchSyncLabels,
  BranchTooltip,
  CommitTooltip,
  CompactBadge,
  IconButton,
  RefLabels,
  RowActions,
  StatLabels,
  WorkingTreeTooltip,
  branchSyncActionLabel,
} from "./SourceControlPanelPrimitives";
import type { ReadySourceControlPanelController } from "./useSourceControlPanelController";
import { Download, Upload } from "lucide-react";
import { TooltipCardPopup } from "../ui/tooltip";
import { formatRelativeDate } from "./SourceControlPanel.logic";
import { AuthorAvatar, SyncedIcon } from "./SourceControlPanelPrimitives";
import { FileChangeList, FileChangeSummary, LoadMoreCommitsButton } from "./SourceControlPanelRows";

export function makeSourceControlPanelBranchRenderers(
  controller: ReadySourceControlPanelController,
) {
  const {
    api,
    branchDetailsByRef,
    checkoutCommitDetached,
    copyText,
    createBranchFromCommit,
    cwd,
    deleteBranch,
    expandedTree,
    fileDiffKey,
    fileDiffListProps,
    isActionRunning,
    isTreeExpanded,
    loadMoreBranchCommits,
    loadingBranchDetails,
    mergeBranchIntoCurrent,
    openContextMenu,
    openFileChangeContextMenu,
    openInVsCode,
    rebaseCurrentOnto,
    resolvedTheme,
    revertCommit,
    runAction,
    runBranchSync,
    setCompareBaseDialogTarget,
    setCompareBaseQuery,
    snapshot,
    switchRef,
    syncBranch,
    toggleBranchTree,
    toggleBranchTreeFromKeyboard,
    toggleTree,
    toggleTreeFromKeyboard,
    undoCommit,
  } = controller;
  const renderCommit = (
    commit: VcsPanelCommitSummary,
    options: { readonly undoBranchName?: string } = {},
  ) => {
    const key = treeKey("commit", commit.sha);
    const expanded = expandedTree.has(key);
    const stats = sumFiles(commit.files);
    const relativeDate = formatRelativeDate(commit.authoredAt);
    const undoKey = options.undoBranchName
      ? commitUndoActionKey(options.undoBranchName, commit.sha)
      : null;
    const revertKey = `commit-revert:${commit.sha}`;
    const rebaseKey = `rebase-current:${commit.sha}`;
    const checkoutKey = `commit-checkout:${commit.sha}`;
    const createBranchKey = `commit-create-branch:${commit.sha}`;
    const canUndoCommit = options.undoBranchName !== undefined;
    return (
      <div key={commit.sha} className="space-y-0.5">
        <Tooltip preserveOnNestedTriggerHover>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
                onClick={() => toggleTree(key)}
                onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      ...(canUndoCommit
                        ? [
                            {
                              id: "undo",
                              label: "Undo",
                              disabled: undoKey ? isActionRunning(undoKey) : false,
                            },
                          ]
                        : []),
                      { id: "revert", label: "Revert commit" },
                      { id: "rebase", label: "Rebase current branch onto commit" },
                      { id: "checkout", label: "Checkout as detached HEAD" },
                      { id: "create-branch", label: "Create branch from commit" },
                      {
                        id: "copy-sha",
                        label: "Copy SHA",
                        icon: "copy",
                        separatorBefore: true,
                      },
                      { id: "copy-message", label: "Copy message", icon: "copy" },
                    ],
                    {
                      undo: () => {
                        if (options.undoBranchName) undoCommit(options.undoBranchName, commit);
                      },
                      revert: () => revertCommit(commit),
                      rebase: () => rebaseCurrentOnto(commit.sha),
                      checkout: () => checkoutCommitDetached(commit),
                      "create-branch": () => createBranchFromCommit(commit),
                      "copy-sha": () => copyText(commit.sha),
                      "copy-message": () => copyText(commit.message),
                    },
                  )
                }
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <AuthorAvatar commit={commit} />
                <span className="min-w-0 flex-1 truncate">{commit.message}</span>
                <RefLabels
                  commit={commit}
                  remoteNames={snapshot.remotes.map((remote) => remote.name)}
                />
                <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
                {relativeDate ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
                ) : null}
                <RowActions>
                  {canUndoCommit && options.undoBranchName ? (
                    <IconButton
                      label="Undo"
                      disabled={undoKey ? isActionRunning(undoKey) : false}
                      loading={undoKey ? isActionRunning(undoKey) : false}
                      onClick={() => {
                        if (options.undoBranchName) undoCommit(options.undoBranchName, commit);
                      }}
                    >
                      <Undo2 className="size-3.5" />
                    </IconButton>
                  ) : null}
                  <IconButton
                    label="Revert commit"
                    disabled={isActionRunning(revertKey)}
                    loading={isActionRunning(revertKey)}
                    onClick={() => revertCommit(commit)}
                  >
                    <RotateCcw className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Rebase current branch onto commit"
                    disabled={isActionRunning(rebaseKey)}
                    loading={isActionRunning(rebaseKey)}
                    onClick={() => rebaseCurrentOnto(commit.sha)}
                  >
                    <GitMerge className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Checkout as detached HEAD"
                    disabled={isActionRunning(checkoutKey)}
                    loading={isActionRunning(checkoutKey)}
                    onClick={() => checkoutCommitDetached(commit)}
                  >
                    <GitCommit className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Create branch from commit"
                    disabled={isActionRunning(createBranchKey)}
                    loading={isActionRunning(createBranchKey)}
                    onClick={() => createBranchFromCommit(commit)}
                  >
                    <GitBranchPlus className="size-3.5" />
                  </IconButton>
                </RowActions>
              </div>
            }
          />
          <TooltipCardPopup side="left" align="start">
            <CommitTooltip
              commit={commit}
              remoteNames={snapshot.remotes.map((remote) => remote.name)}
            />
          </TooltipCardPopup>
        </Tooltip>
        {expanded ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            <FileChangeList
              files={commit.files}
              emptyLabel="No file changes."
              onFileContextMenu={openFileChangeContextMenu}
              {...fileDiffListProps(() => ({ kind: "commit", sha: commit.sha }))}
            />
          </div>
        ) : null}
      </div>
    );
  };

  const renderBranchSubsection = ({
    details,
    id,
    title,
    count,
    children,
    icon,
    action,
    defaultExpanded,
  }: {
    readonly details: VcsPanelBranchDetails;
    readonly id: string;
    readonly title: ReactNode;
    readonly count: ReactNode | null;
    readonly children: ReactNode;
    readonly icon?: ReactNode;
    readonly action?: ReactNode;
    readonly defaultExpanded?: boolean;
  }) => {
    const key = treeKey("branch-subsection", `${details.fullRefName}:${id}`);
    const expanded = isTreeExpanded(key, defaultExpanded);
    return (
      <div className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key, defaultExpanded)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event, defaultExpanded)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {icon}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {action}
          {count !== null ? <span className="shrink-0 text-muted-foreground">{count}</span> : null}
        </div>
        {expanded ? <div className="ml-2 border-l border-border/60 pl-1">{children}</div> : null}
      </div>
    );
  };

  const renderBranchTree = (branch: VcsRef, details: VcsPanelBranchDetails, detailsKey: string) => {
    const unsyncedCommitShas = new Set(details.unsyncedCommitShas);
    const loadingDetails = loadingBranchDetails.has(detailsKey);
    const aheadTotal = details.aheadCommits.length + details.aheadCommitsRemaining;
    const behindTotal = details.behindCommits.length + details.behindCommitsRemaining;
    const historyTotal = details.commits.length + details.commitsRemaining;
    const openCompareBaseDialog = () => {
      setCompareBaseDialogTarget({ branch, detailsKey });
      setCompareBaseQuery("");
    };
    const renderBranchCommit = (commit: VcsPanelCommitSummary) =>
      renderCommit(
        commit,
        unsyncedCommitShas.has(commit.sha) ? { undoBranchName: branch.name } : undefined,
      );
    return (
      <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
        <button
          type="button"
          className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={openCompareBaseDialog}
        >
          <span className="min-w-0 flex-1 truncate">vs. {details.baseRef ?? "choose base"}</span>
        </button>
        {aheadTotal > 0
          ? renderBranchSubsection({
              details,
              id: "ahead",
              title: `${aheadTotal} Ahead`,
              count: null,
              icon: <Upload className="size-3.5 shrink-0 text-success-foreground" />,
              children: (
                <div className="space-y-0.5">
                  {details.aheadCommits.map(renderBranchCommit)}
                  <LoadMoreCommitsButton
                    remaining={details.aheadCommitsRemaining}
                    loading={loadingDetails}
                    onClick={() => void loadMoreBranchCommits(branch, details, "ahead", detailsKey)}
                  />
                </div>
              ),
            })
          : null}
        {behindTotal > 0
          ? renderBranchSubsection({
              details,
              id: "behind",
              title: `${behindTotal} Behind`,
              count: null,
              icon: <Download className="size-3.5 shrink-0 text-warning-foreground" />,
              children: (
                <div className="space-y-0.5">
                  {details.behindCommits.map(renderBranchCommit)}
                  <LoadMoreCommitsButton
                    remaining={details.behindCommitsRemaining}
                    loading={loadingDetails}
                    onClick={() =>
                      void loadMoreBranchCommits(branch, details, "behind", detailsKey)
                    }
                  />
                </div>
              ),
            })
          : null}
        {renderBranchSubsection({
          details,
          id: "commits",
          title: "History",
          count: commitCountLabel(historyTotal),
          children: (
            <div className="space-y-0.5">
              {details.commits.length === 0 ? (
                <div className="px-3 py-1 text-xs text-muted-foreground">No commits.</div>
              ) : (
                details.commits.map(renderBranchCommit)
              )}
              <LoadMoreCommitsButton
                remaining={details.commitsRemaining}
                loading={loadingDetails}
                onClick={() => void loadMoreBranchCommits(branch, details, "history", detailsKey)}
              />
            </div>
          ),
        })}
        {details.baseRef
          ? renderBranchSubsection({
              details,
              id: "compare-changes",
              title: "Changes",
              count: null,
              action: <FileChangeSummary files={details.compareFiles} />,
              children: (
                <FileChangeList
                  files={details.compareFiles}
                  emptyLabel="No changes."
                  onFileContextMenu={openFileChangeContextMenu}
                  {...fileDiffListProps(() => ({
                    kind: "compare",
                    baseRef: details.baseRef!,
                    refName: details.name,
                  }))}
                />
              ),
            })
          : null}
      </div>
    );
  };

  const branchRow = (
    branch: VcsRef,
    options: {
      readonly key?: string;
      readonly detailsKey?: string;
      readonly compareBaseRef?: string;
      readonly syncCounts?: { readonly aheadCount: number; readonly behindCount: number };
      readonly attention?: AttentionKind;
      readonly syncLabel?: string;
      readonly syncState?: BranchSyncState;
      readonly syncActionKey?: string;
      readonly fetchActionKey?: string;
      readonly onSync?: (event?: ReactMouseEvent<HTMLButtonElement>) => void;
      readonly secondaryBadge?: ReactNode;
    } = {},
  ) => {
    const detailsKey = options.detailsKey ?? branch.name;
    const details = branchDetailsByRef.get(detailsKey);
    const key = options.key ?? treeKey("branch", branch.name);
    const expanded = expandedTree.has(key);
    const loadingDetails = loadingBranchDetails.has(detailsKey);
    const current = branch.current;
    const { aheadCount, behindCount } = options.syncCounts ?? branchSyncCounts(branch, snapshot);
    const hasUpstream = branchHasUpstream(branch, snapshot);
    const attention = options.attention ?? branchAttention(branch, snapshot);
    const syncState = options.syncState ?? branchSyncState(branch, snapshot);
    const switchKey = `branch-switch:${branch.name}`;
    const syncKey = options.syncActionKey ?? `branch-sync:${branch.name}`;
    const fetchKey = options.fetchActionKey ?? `branch-fetch:${branch.name}`;
    const deleteKey = `branch-delete:${branch.name}`;
    const undoKey = `branch-undo-latest:${branch.name}`;
    const mergeKey = `branch-merge:${branch.name}`;
    const rebaseKey = `rebase-current:${branch.name}`;
    const syncLabel = options.syncLabel ?? branchSyncActionLabel(syncState);
    const relativeDate = formatRelativeDate(branch.lastActivityAt);
    const checkedOut = branchIsCheckedOut(branch);
    const switchDisabled = checkedOut || isActionRunning(switchKey);
    const syncDisabled = isActionRunning(syncKey) || isActionRunning(fetchKey);
    const deleteDisabled = checkedOut || isActionRunning(deleteKey);
    const runSync = (event?: ReactMouseEvent<HTMLButtonElement>) =>
      options.onSync
        ? options.onSync(event)
        : event
          ? syncBranch(branch, event)
          : runBranchSync(branch);
    return (
      <div key={key} className="space-y-0.5">
        <Tooltip preserveOnNestedTriggerHover>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
                onClick={() => toggleBranchTree(key, branch, options.compareBaseRef, detailsKey)}
                onKeyDown={(event) =>
                  toggleBranchTreeFromKeyboard(
                    key,
                    branch,
                    event,
                    options.compareBaseRef,
                    detailsKey,
                  )
                }
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      { id: "switch", label: "Checkout", disabled: switchDisabled },
                      { id: "sync", label: syncLabel, disabled: syncDisabled },
                      ...(current && aheadCount > 0
                        ? [
                            {
                              id: "undo-latest",
                              label: "Undo latest commit",
                              disabled: isActionRunning(undoKey),
                            },
                          ]
                        : []),
                      ...(!current
                        ? [
                            {
                              id: "merge",
                              label: "Merge branch into current",
                              disabled: isActionRunning(mergeKey),
                            },
                            {
                              id: "rebase",
                              label: "Rebase current branch onto branch",
                              disabled: isActionRunning(rebaseKey),
                            },
                          ]
                        : []),
                      {
                        id: "delete",
                        label: "Delete branch",
                        destructive: true,
                        disabled: deleteDisabled,
                        icon: "trash",
                        separatorBefore: true,
                      },
                      {
                        id: "copy-branch-name",
                        label: "Copy branch name",
                        icon: "copy",
                        separatorBefore: true,
                      },
                    ],
                    {
                      switch: () => switchRef(branch.name),
                      sync: () => runSync(),
                      delete: () => deleteBranch(branch, false),
                      "undo-latest": () => undoCommit(branch.name),
                      merge: () => mergeBranchIntoCurrent(branch.name),
                      rebase: () => rebaseCurrentOnto(branch.name),
                      "copy-branch-name": () => copyText(branch.name),
                    },
                  )
                }
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <AttentionIcon kind={attention} />
                <span className="min-w-0 flex-1 truncate text-sm">{branch.name}</span>
                <div className="pointer-events-none ml-auto flex min-w-0 shrink-0 items-center gap-1">
                  {hasUpstream && aheadCount === 0 && behindCount === 0 ? (
                    <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
                      <SyncedIcon />
                    </span>
                  ) : null}
                  {!hasUpstream ? <CompactBadge>local</CompactBadge> : null}
                  {options.secondaryBadge}
                  {current ? <CompactBadge>current</CompactBadge> : null}
                  {branch.isDefault ? <CompactBadge>default</CompactBadge> : null}
                  {branch.worktreePath && !current ? <CompactBadge>worktree</CompactBadge> : null}
                  <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
                  {relativeDate ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {relativeDate}
                    </span>
                  ) : null}
                </div>
                <RowActions>
                  <IconButton
                    label="Checkout"
                    disabled={switchDisabled}
                    loading={isActionRunning(switchKey)}
                    onClick={() => void switchRef(branch.name)}
                  >
                    <GitBranch className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label={syncLabel}
                    disabled={syncDisabled}
                    loading={isActionRunning(syncKey) || isActionRunning(fetchKey)}
                    onClick={(event) => runSync(event)}
                  >
                    <BranchSyncActionIcon state={syncState} />
                  </IconButton>
                  <IconButton
                    label="Delete branch. Shift: force."
                    destructive
                    disabled={deleteDisabled}
                    loading={isActionRunning(deleteKey)}
                    onClick={(event) => deleteBranch(branch, isActionForced(event))}
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                  {current && aheadCount > 0 ? (
                    <IconButton
                      label="Undo latest commit"
                      disabled={isActionRunning(undoKey)}
                      loading={isActionRunning(undoKey)}
                      onClick={() => undoCommit(branch.name)}
                    >
                      <Undo2 className="size-3.5" />
                    </IconButton>
                  ) : null}
                  {!current ? (
                    <>
                      <IconButton
                        label="Merge branch into current"
                        disabled={isActionRunning(mergeKey)}
                        loading={isActionRunning(mergeKey)}
                        onClick={() => mergeBranchIntoCurrent(branch.name)}
                      >
                        <GitMerge className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label="Rebase current branch onto branch"
                        disabled={isActionRunning(rebaseKey)}
                        loading={isActionRunning(rebaseKey)}
                        onClick={() => rebaseCurrentOnto(branch.name)}
                      >
                        <GitPullRequestArrow className="size-3.5" />
                      </IconButton>
                    </>
                  ) : null}
                </RowActions>
              </div>
            }
          />
          <BranchTooltip
            branch={branch}
            displayName={branch.name}
            aheadCount={aheadCount}
            behindCount={behindCount}
          />
        </Tooltip>
        {expanded && details ? renderBranchTree(branch, details, detailsKey) : null}
        {expanded && !details && loadingDetails ? (
          <div className="ml-2 border-l border-border/60 px-2 py-1 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  };

  const remoteBranchRow = (branch: VcsRef, displayName: string, hasLocalBranch: boolean) => {
    const details = branchDetailsByRef.get(branch.name);
    const key = treeKey("remote-branch", `${branch.remoteName ?? "local"}:${displayName}`);
    const expanded = expandedTree.has(key);
    const loadingDetails = loadingBranchDetails.has(branch.name);
    const current = branch.current;
    const relativeDate = formatRelativeDate(branch.lastActivityAt);
    const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
    const hasUpstream = branchHasUpstream(branch, snapshot);
    const syncState = branchSyncState(branch, snapshot);
    const switchKey = `branch-switch:${branch.name}`;
    const syncKey = `branch-sync:${branch.name}`;
    const fetchKey = `branch-fetch:${branch.name}`;
    const deleteKey = `branch-delete:${branch.name}`;
    const undoKey = `branch-undo-latest:${branch.name}`;
    const mergeKey = `branch-merge:${branch.name}`;
    const rebaseKey = `rebase-current:${branch.name}`;
    const checkedOut = hasLocalBranch && branchIsCheckedOut(branch);
    const switchDisabled = checkedOut || isActionRunning(switchKey);
    const syncLabel = hasLocalBranch ? branchSyncActionLabel(syncState) : "Fetch branch";
    const syncDisabled = hasLocalBranch
      ? isActionRunning(syncKey) || isActionRunning(fetchKey)
      : isActionRunning(fetchKey);
    const deleteDisabled = checkedOut || isActionRunning(deleteKey);
    const fetchRemoteBranch = () =>
      void runAction(
        fetchKey,
        () => api?.vcs.fetchBranch({ cwd, branchName: branch.name }) ?? Promise.resolve(),
      );
    return (
      <div key={`${branch.remoteName ?? "local"}:${displayName}`} className="space-y-0.5">
        <Tooltip preserveOnNestedTriggerHover>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
                onClick={() => toggleBranchTree(key, branch)}
                onKeyDown={(event) => toggleBranchTreeFromKeyboard(key, branch, event)}
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      { id: "switch", label: "Checkout", disabled: switchDisabled },
                      { id: "sync", label: syncLabel, disabled: syncDisabled },
                      ...(current && aheadCount > 0
                        ? [
                            {
                              id: "undo-latest",
                              label: "Undo latest commit",
                              disabled: isActionRunning(undoKey),
                            },
                          ]
                        : []),
                      ...(!current
                        ? [
                            {
                              id: "merge",
                              label: "Merge branch into current",
                              disabled: isActionRunning(mergeKey),
                            },
                            {
                              id: "rebase",
                              label: "Rebase current branch onto branch",
                              disabled: isActionRunning(rebaseKey),
                            },
                          ]
                        : []),
                      {
                        id: "delete",
                        label: hasLocalBranch ? "Delete branch" : "Delete remote branch",
                        destructive: true,
                        disabled: deleteDisabled,
                        icon: "trash",
                        separatorBefore: true,
                      },
                      {
                        id: "copy-branch-name",
                        label: "Copy branch name",
                        icon: "copy",
                        separatorBefore: true,
                      },
                    ],
                    {
                      switch: () => switchRef(branch.name),
                      sync: () => (hasLocalBranch ? runBranchSync(branch) : fetchRemoteBranch()),
                      delete: () => deleteBranch(branch, false),
                      "undo-latest": () => undoCommit(branch.name),
                      merge: () => mergeBranchIntoCurrent(branch.name),
                      rebase: () => rebaseCurrentOnto(branch.name),
                      "copy-branch-name": () => copyText(displayName),
                    },
                  )
                }
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                {hasLocalBranch ? (
                  <SyncedIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{displayName}</span>
                <div className="pointer-events-none ml-auto flex min-w-0 shrink-0 items-center gap-1">
                  {hasLocalBranch && !hasUpstream ? <CompactBadge>local</CompactBadge> : null}
                  {current ? <CompactBadge>current</CompactBadge> : null}
                  {branch.isDefault ? <CompactBadge>default</CompactBadge> : null}
                  <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
                  {relativeDate ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {relativeDate}
                    </span>
                  ) : null}
                </div>
                <RowActions>
                  <IconButton
                    label="Checkout"
                    disabled={switchDisabled}
                    loading={isActionRunning(switchKey)}
                    onClick={() => void switchRef(branch.name)}
                  >
                    <GitBranch className="size-3.5" />
                  </IconButton>
                  {hasLocalBranch ? (
                    <IconButton
                      label={branchSyncActionLabel(syncState)}
                      disabled={syncDisabled}
                      loading={isActionRunning(syncKey) || isActionRunning(fetchKey)}
                      onClick={(event) => syncBranch(branch, event)}
                    >
                      <BranchSyncActionIcon state={syncState} />
                    </IconButton>
                  ) : (
                    <IconButton
                      label="Fetch branch"
                      disabled={syncDisabled}
                      loading={isActionRunning(fetchKey)}
                      onClick={fetchRemoteBranch}
                    >
                      <RefreshCw className="size-3.5" />
                    </IconButton>
                  )}
                  <IconButton
                    label={hasLocalBranch ? "Delete branch. Shift: force." : "Delete remote branch"}
                    destructive
                    disabled={deleteDisabled}
                    loading={isActionRunning(deleteKey)}
                    onClick={(event) =>
                      deleteBranch(branch, hasLocalBranch && isActionForced(event))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                  {current && aheadCount > 0 ? (
                    <IconButton
                      label="Undo latest commit"
                      disabled={isActionRunning(undoKey)}
                      loading={isActionRunning(undoKey)}
                      onClick={() => undoCommit(branch.name)}
                    >
                      <Undo2 className="size-3.5" />
                    </IconButton>
                  ) : null}
                  {!current ? (
                    <>
                      <IconButton
                        label="Merge branch into current"
                        disabled={isActionRunning(mergeKey)}
                        loading={isActionRunning(mergeKey)}
                        onClick={() => mergeBranchIntoCurrent(branch.name)}
                      >
                        <GitMerge className="size-3.5" />
                      </IconButton>
                      <IconButton
                        label="Rebase current branch onto branch"
                        disabled={isActionRunning(rebaseKey)}
                        loading={isActionRunning(rebaseKey)}
                        onClick={() => rebaseCurrentOnto(branch.name)}
                      >
                        <GitPullRequestArrow className="size-3.5" />
                      </IconButton>
                    </>
                  ) : null}
                </RowActions>
              </div>
            }
          />
          <BranchTooltip
            branch={branch}
            displayName={displayName}
            aheadCount={aheadCount}
            behindCount={behindCount}
          />
        </Tooltip>
        {expanded && details ? renderBranchTree(branch, details, branch.name) : null}
        {expanded && !details && loadingDetails ? (
          <div className="ml-2 border-l border-border/60 px-2 py-1 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  };

  return { branchRow, remoteBranchRow, renderCommit };
}
