import type {
  EnvironmentId,
  ThreadId,
  VcsPanelChangeGroup,
  VcsPanelFileDiffInput,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelWorktreeChangeSet,
  VcsRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommit,
  GitPullRequestArrow,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

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
  branchOperationCwd,
  branchSyncCounts,
  completePanelFileDiffLoad,
  failPanelFileDiffLoad,
  mergeChangeGroups,
  runPanelActionAndReconcile,
  type PanelChangedFile,
  stashIdentityKey,
} from "./SourceControlPanel.logic";
import {
  COMMIT_PAGE_SIZE,
  MIN_SECTION_WEIGHT,
  SECTION_TITLES,
  applyWorkingTreeFileEnrichment,
  branchActivityTimestamp,
  compareBaseRefNames,
  errorMessage,
  expandedStashesForSnapshot,
  fileBasename,
  isActionForced,
  localOnlyBranches,
  operationPathsForFile,
  shouldEnrichWorkingTreeFile,
  stashBranchName,
  sumFiles,
  treeKey,
  uniquePaths,
  changeSetAttention,
  contextMenuSeparator,
  type FileDiffSource,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";
import {
  ATTENTION_RANK,
  AttentionIcon,
  BranchSyncLabels,
  CommitTooltip,
  CompactBadge,
  IconButton,
  RemoteTooltip,
  RowActions,
  StatLabels,
  WorkingFileTooltipRow,
  WorkingTreeTooltip,
  stashActivityTimestamp,
} from "./SourceControlPanelPrimitives";
import type { ReadySourceControlPanelController } from "./useSourceControlPanelController";
import { FileChangeSummary, WorkingFileRow } from "./SourceControlPanelRows";
import { FileText } from "lucide-react";
import { VisualStudioCode } from "../Icons";
import { TooltipPopup } from "../ui/tooltip";
import { fileStatusColor, fileStatusLetter } from "./SourceControlPanelPrimitives";

export function makeSourceControlPanelWorkingTreeRenderers(
  controller: ReadySourceControlPanelController,
) {
  const {
    api,
    changedFiles,
    commitSelectedInCwd,
    confirm,
    copyText,
    cwd,
    displayedChangeGroups,
    discardSelectedInCwd,
    expandedFileDiffs,
    fileDiffKey,
    discardSelectedChanges,
    filePanelThreadRef,
    gitAction,
    isActionRunning,
    isTreeExpanded,
    openCommitDialog,
    openContextMenu,
    openFilePanel,
    openInVsCode,
    openStashDialog,
    queueWorkingTreeFileEnrichment,
    renderFileDiff,
    selectedChangePaths,
    setSelectedChangePaths,
    setSelectedWorktreeChangePaths,
    runAction,
    runGeneratedPanelCommit,
    runGeneratedPanelStash,
    snapshot,
    stashSelectedInCwd,
    toggleAllChangedFilesSelection,
    toggleFileDiff,
    toggleTree,
    toggleTreeFromKeyboard,
    worktreeChangeSetViews,
    worktreePath,
  } = controller;
  const currentBranch = snapshot?.localBranches.find((branch) => branch.current) ?? null;
  const currentWorkingTreeChangeSet: WorkingTreeChangeSetView = {
    id: "working-tree",
    label: "Working tree",
    cwd,
    branchName: currentBranch?.name ?? null,
    worktreePath,
    current: true,
    changeGroups: displayedChangeGroups,
    files: changedFiles,
    selectedPaths: selectedChangePaths,
    activity: currentBranch ? branchActivityTimestamp(currentBranch) : 0,
  };
  const toggleChangeSetFileSelection = (
    changeSet: WorkingTreeChangeSetView,
    path: string,
    checked: boolean,
  ) => {
    if (changeSet.current) {
      setSelectedChangePaths((current) => {
        const next = new Set(current);
        if (checked) next.add(path);
        else next.delete(path);
        return next;
      });
      return;
    }
    setSelectedWorktreeChangePaths((current) => {
      const next = new Map(current);
      const paths = new Set(next.get(changeSet.id) ?? []);
      if (checked) paths.add(path);
      else paths.delete(path);
      next.set(changeSet.id, paths);
      return next;
    });
  };

  const renderWorkingFile = (changeSet: WorkingTreeChangeSetView) => (file: PanelChangedFile) => {
    const selected = changeSet.selectedPaths.has(file.path);
    const discardKey = `${changeSet.id}:file-discard:${file.path}`;
    const diffSource = {
      kind: "working-tree",
      staged: !file.hasUnstagedChanges && file.hasStagedChanges,
    } satisfies FileDiffSource;
    const diffExpanded = expandedFileDiffs.has(fileDiffKey(file, diffSource, changeSet.cwd));
    const discardFile = () =>
      void (async () => {
        if (!(await confirm(`Discard changes in ${file.path}?`))) return;
        await runAction(discardKey, async () => {
          if (!api) return;
          const paths = operationPathsForFile(file);
          if (file.hasUnstagedChanges) {
            await api.vcs.discardFiles({ cwd: changeSet.cwd, paths, staged: false });
          }
          if (file.hasStagedChanges) {
            await api.vcs.discardFiles({ cwd: changeSet.cwd, paths, staged: true });
          }
        });
      })();
    return (
      <div key={file.path} className="space-y-0.5">
        <WorkingFileTooltipRow
          file={file}
          onToggle={() => toggleFileDiff(file, diffSource, changeSet.cwd)}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                ...(filePanelThreadRef ? ([{ id: "open-file", label: "Open file" }] as const) : []),
                { id: "open-vscode", label: "Open in VS Code" },
                contextMenuSeparator("discard-separator"),
                {
                  id: "discard",
                  label: "Discard change",
                  destructive: true,
                  disabled: isActionRunning(discardKey),
                  icon: "trash",
                },
                contextMenuSeparator("copy-separator"),
                { id: "copy-filename", label: "Copy filename", icon: "copy" },
                { id: "copy-full-path", label: "Copy full path to file", icon: "copy" },
              ],
              {
                discard: discardFile,
                ...(filePanelThreadRef
                  ? { "open-file": () => openFilePanel(file.path, changeSet.cwd) }
                  : {}),
                "open-vscode": () => openInVsCode(file.path, changeSet.cwd),
                "copy-filename": () => copyText(fileBasename(file.path)),
                "copy-full-path": () => copyText(resolvePathLinkTarget(file.path, changeSet.cwd)),
              },
            )
          }
        >
          {diffExpanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span onClick={(event) => event.stopPropagation()}>
            <Checkbox
              checked={selected}
              disabled={isActionRunning(discardKey)}
              aria-label={selected ? `Deselect ${file.path}` : `Select ${file.path}`}
              onCheckedChange={(checked) =>
                toggleChangeSetFileSelection(changeSet, file.path, checked === true)
              }
            />
          </span>
          <span
            className={cn(
              "w-3 shrink-0 text-center text-[10px] font-semibold uppercase",
              fileStatusColor(file.status),
            )}
          >
            {fileStatusLetter(file.status)}
          </span>
          <span className="min-w-0 flex-1 truncate">{file.path}</span>
          <StatLabels insertions={file.insertions} deletions={file.deletions} />
          <RowActions>
            <IconButton
              label="Discard changes"
              destructive
              disabled={isActionRunning(discardKey)}
              loading={isActionRunning(discardKey)}
              onClick={discardFile}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
            {filePanelThreadRef ? (
              <IconButton label="Open file" onClick={() => openFilePanel(file.path, changeSet.cwd)}>
                <FileText className="size-3.5" />
              </IconButton>
            ) : null}
            <IconButton
              label="Open in VS Code"
              onClick={() => void openInVsCode(file.path, changeSet.cwd)}
            >
              <VisualStudioCode className="size-3.5" />
            </IconButton>
          </RowActions>
        </WorkingFileTooltipRow>
        {diffExpanded ? (
          <div className="ml-4 border-l border-border/60 pl-1">
            {renderFileDiff(file, diffSource, changeSet.cwd)}
          </div>
        ) : null}
      </div>
    );
  };

  const renderChangesSection = (changeSet: WorkingTreeChangeSetView) => {
    const files = changeSet.files;
    const selectedFiles = files.filter((file) => changeSet.selectedPaths.has(file.path));
    const selectedPathList = uniquePaths(
      selectedFiles.flatMap((file) => operationPathsForFile(file)),
    );
    const selectedStats = sumFiles(selectedFiles);
    const allSelected = files.length > 0 && selectedFiles.length === files.length;
    const noneSelected = selectedFiles.length === 0;
    const partialSelected = files.length > 0 && !allSelected && !noneSelected;
    const commitActionKey = changeSet.current ? "changes-commit" : `${changeSet.id}:changes-commit`;
    const stashActionKey = changeSet.current ? "changes-stash" : `${changeSet.id}:changes-stash`;
    const discardActionKey = changeSet.current
      ? "changes-discard-selected"
      : `${changeSet.id}:changes-discard-selected`;
    const toggleAllSelection = () => {
      if (changeSet.current) {
        toggleAllChangedFilesSelection();
        return;
      }
      setSelectedWorktreeChangePaths((current) => {
        const next = new Map(current);
        next.set(changeSet.id, allSelected ? new Set() : new Set(files.map((file) => file.path)));
        return next;
      });
    };
    const commitSelected = () => {
      if (changeSet.current) {
        void runGeneratedPanelCommit();
        return;
      }
      void commitSelectedInCwd({
        targetCwd: changeSet.cwd,
        actionKey: commitActionKey,
        files: selectedFiles,
      });
    };
    const stashSelected = (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.shiftKey) {
        openStashDialog("selected", selectedPathList, changeSet.cwd, stashActionKey);
        return;
      }
      if (changeSet.current) {
        void runGeneratedPanelStash();
        return;
      }
      void stashSelectedInCwd({
        targetCwd: changeSet.cwd,
        actionKey: stashActionKey,
        paths: selectedPathList,
      });
    };
    const discardSelected = () => {
      if (changeSet.current) {
        discardSelectedChanges();
        return;
      }
      discardSelectedInCwd({
        targetCwd: changeSet.cwd,
        actionKey: discardActionKey,
        files: selectedFiles,
      });
    };

    return (
      <div className="space-y-2">
        {files.length === 0 ? (
          <div className="px-1 py-1 text-sm text-muted-foreground">Working tree clean</div>
        ) : (
          <>
            <div className="flex h-6 shrink-0 items-center justify-between gap-2 rounded px-1 text-xs font-medium uppercase text-muted-foreground">
              <div className="flex min-w-0 items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 items-center">
                        <Checkbox
                          checked={allSelected}
                          indeterminate={partialSelected}
                          aria-label={allSelected ? "Unselect all files" : "Select all files"}
                          onCheckedChange={toggleAllSelection}
                        />
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {allSelected ? "Unselect all files" : "Select all files"}
                  </TooltipPopup>
                </Tooltip>
                <span className="min-w-0 truncate">
                  {selectedFiles.length} of {files.length} files selected
                </span>
                <StatLabels
                  insertions={selectedStats.insertions}
                  deletions={selectedStats.deletions}
                />
              </div>
              <div className="flex items-center gap-1">
                <IconButton
                  label={
                    changeSet.current
                      ? "Commit selected changes. Shift: message."
                      : "Commit selected changes"
                  }
                  disabled={
                    isActionRunning(commitActionKey) ||
                    (changeSet.current && gitAction.isPending) ||
                    selectedFiles.length === 0
                  }
                  loading={
                    isActionRunning(commitActionKey) || (changeSet.current && gitAction.isPending)
                  }
                  onClick={(event) =>
                    changeSet.current && event.shiftKey ? openCommitDialog() : commitSelected()
                  }
                >
                  <GitCommit className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Stash selected changes. Shift: message."
                  disabled={isActionRunning(stashActionKey) || selectedFiles.length === 0}
                  loading={isActionRunning(stashActionKey)}
                  onClick={stashSelected}
                >
                  <Archive className="size-3.5" />
                </IconButton>
                <IconButton
                  label="Discard selected changes"
                  destructive
                  disabled={isActionRunning(discardActionKey) || selectedFiles.length === 0}
                  loading={isActionRunning(discardActionKey)}
                  onClick={discardSelected}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            </div>
            <div className="space-y-0.5">
              {files.map((file) => (
                <WorkingFileRow
                  key={file.path}
                  file={file}
                  onRendered={(renderedFile) =>
                    queueWorkingTreeFileEnrichment(renderedFile, changeSet.cwd)
                  }
                  renderFile={renderWorkingFile(changeSet)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    );
  };

  type WorkItem =
    | {
        readonly kind: "working-tree";
        readonly key: string;
        readonly changeSet: WorkingTreeChangeSetView;
        readonly attention: AttentionKind;
        readonly activity: number;
      }
    | {
        readonly kind: "branch";
        readonly key: string;
        readonly branch: VcsRef;
        readonly attention: AttentionKind;
        readonly activity: number;
      }
    | {
        readonly kind: "fork-branch";
        readonly key: string;
        readonly branch: VcsRef;
        readonly fork: VcsPanelSnapshotResult["actionableForkBranches"][number];
        readonly attention: AttentionKind;
        readonly activity: number;
      }
    | {
        readonly kind: "stash";
        readonly key: string;
        readonly stash: VcsPanelStash;
        readonly attention: AttentionKind;
        readonly activity: number;
      };

  const localBranchesWithoutUpstream = localOnlyBranches(snapshot);
  const workingTreeChangeSets = [
    ...(currentWorkingTreeChangeSet.files.length > 0 ? [currentWorkingTreeChangeSet] : []),
    ...worktreeChangeSetViews,
  ];
  const workItems: WorkItem[] = [
    ...workingTreeChangeSets.map((changeSet) => ({
      kind: "working-tree" as const,
      key: changeSet.id,
      changeSet,
      attention: changeSetAttention(changeSet.files),
      activity: changeSet.activity,
    })),
    ...snapshot.localBranches
      .filter((branch) => {
        const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
        return !branchHasUpstream(branch, snapshot) || aheadCount > 0 || behindCount > 0;
      })
      .map((branch) => ({
        kind: "branch" as const,
        key: `branch:${branch.name}`,
        branch,
        attention: branchAttention(branch, snapshot),
        activity: branchActivityTimestamp(branch),
      })),
    ...snapshot.actionableForkBranches.flatMap((fork) => {
      const branch = snapshot.localBranches.find(
        (localBranch) => localBranch.name === fork.localBranchName,
      );
      if (!branch) return [];
      return [
        {
          kind: "fork-branch" as const,
          key: `fork:${fork.localBranchName}:${fork.remoteRefName}`,
          branch,
          fork,
          attention: "behind" as const,
          activity: branchActivityTimestamp(fork),
        },
      ];
    }),
    ...snapshot.stashes.map((stash) => ({
      kind: "stash" as const,
      key: `stash:${stashIdentityKey(stash)}`,
      stash,
      attention: "dirty" as const,
      activity: stashActivityTimestamp(stash),
    })),
  ].toSorted((left, right) => {
    if (left.kind === "working-tree" && right.kind !== "working-tree") return -1;
    if (right.kind === "working-tree" && left.kind !== "working-tree") return 1;
    if (left.kind === "working-tree" && right.kind === "working-tree") {
      if (left.changeSet.current !== right.changeSet.current)
        return left.changeSet.current ? -1 : 1;
    }
    const attention = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention];
    if (attention !== 0) return attention;
    return right.activity - left.activity;
  });

  const renderWorkingTreeRow = (changeSet: WorkingTreeChangeSetView) => {
    const key = treeKey("work", changeSet.id);
    const expanded = isTreeExpanded(key, changeSet.current);
    const branch = changeSet.branchName
      ? snapshot.localBranches.find((candidate) => candidate.name === changeSet.branchName)
      : currentBranch;
    const { aheadCount, behindCount } = branch
      ? branchSyncCounts(branch, snapshot)
      : { aheadCount: 0, behindCount: 0 };
    const attention = changeSetAttention(changeSet.files);
    const selectedFiles = changeSet.files.filter((file) => changeSet.selectedPaths.has(file.path));
    const selectedPathList = uniquePaths(
      selectedFiles.flatMap((file) => operationPathsForFile(file)),
    );
    const commitActionKey = changeSet.current ? "changes-commit" : `${changeSet.id}:changes-commit`;
    const stashActionKey = changeSet.current ? "changes-stash" : `${changeSet.id}:changes-stash`;
    const discardActionKey = changeSet.current
      ? "changes-discard-selected"
      : `${changeSet.id}:changes-discard-selected`;
    const commitSelected = () => {
      if (changeSet.current) {
        void runGeneratedPanelCommit();
        return;
      }
      void commitSelectedInCwd({
        targetCwd: changeSet.cwd,
        actionKey: commitActionKey,
        files: selectedFiles,
      });
    };
    const stashSelected = () => {
      if (changeSet.current) {
        void runGeneratedPanelStash();
        return;
      }
      void stashSelectedInCwd({
        targetCwd: changeSet.cwd,
        actionKey: stashActionKey,
        paths: selectedPathList,
      });
    };
    const discardSelected = () => {
      if (changeSet.current) {
        discardSelectedChanges();
        return;
      }
      discardSelectedInCwd({
        targetCwd: changeSet.cwd,
        actionKey: discardActionKey,
        files: selectedFiles,
      });
    };
    return (
      <div className="space-y-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                role="button"
                tabIndex={0}
                className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
                onClick={() => toggleTree(key, changeSet.current)}
                onKeyDown={(event) => toggleTreeFromKeyboard(key, event, changeSet.current)}
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      {
                        id: "commit-selected",
                        label: "Commit selected changes",
                        disabled:
                          isActionRunning(commitActionKey) ||
                          (changeSet.current && gitAction.isPending) ||
                          selectedFiles.length === 0,
                      },
                      {
                        id: "stash-selected",
                        label: "Stash selected changes",
                        disabled: isActionRunning(stashActionKey) || selectedFiles.length === 0,
                      },
                      contextMenuSeparator("discard-separator-before"),
                      {
                        id: "discard-selected",
                        label: "Discard selected changes",
                        destructive: true,
                        disabled: isActionRunning(discardActionKey) || selectedFiles.length === 0,
                        icon: "trash",
                      },
                    ],
                    {
                      "commit-selected": commitSelected,
                      "stash-selected": stashSelected,
                      "discard-selected": discardSelected,
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
                <span className="min-w-0 flex-1 truncate text-sm">{changeSet.label}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {changeSet.current && currentBranch ? (
                    <CompactBadge>{currentBranch.name}</CompactBadge>
                  ) : null}
                  {!changeSet.current && changeSet.worktreePath ? (
                    <CompactBadge>{fileBasename(changeSet.worktreePath)}</CompactBadge>
                  ) : null}
                  {changeSet.files.length > 0 ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {changeSet.files.length === 1 ? "1 file" : `${changeSet.files.length} files`}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground">clean</span>
                  )}
                  <BranchSyncLabels aheadCount={aheadCount} behindCount={behindCount} />
                </div>
              </div>
            }
          />
          <WorkingTreeTooltip changeSet={changeSet} />
        </Tooltip>
        {expanded ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            {renderChangesSection(changeSet)}
          </div>
        ) : null}
      </div>
    );
  };

  return {
    localBranchesWithoutUpstream,
    renderChangesSection,
    renderWorkingTreeRow,
    workItems,
    workingTreeChangeSets,
  };
}
