import type {
  EnvironmentId,
  ThreadId,
  VcsPanelChangeGroup,
  VcsPanelFileDiffInput,
  VcsPanelRemote,
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
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
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
  beginPanelFileDiffLoad,
  branchHasUpstream,
  branchOperationCwd,
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
  localBranchForRemoteBranch,
  mapBranchDetails,
  remoteBranchRef,
  shouldFetchBeforePull,
  stashBranchName,
  splitEnrichmentFileKey,
  treeKey,
  worktreeChangeSetId,
  commitCountLabel,
  type FileDiffSource,
  type WorkingTreeChangeSetView,
} from "./SourceControlPanelModel";
import {
  AttentionIcon,
  BranchSyncLabels,
  CommitTooltip,
  FileChangeTooltipRow,
  IconButton,
  RemoteTooltip,
  RowActions,
  StashTooltip,
  WorkingFileTooltipRow,
  branchSyncActionLabel,
} from "./SourceControlPanelPrimitives";
import type { ReadySourceControlPanelController } from "./useSourceControlPanelController";
import type { makeSourceControlPanelBranchRenderers } from "./SourceControlPanelBranches";
import { Download } from "lucide-react";
import { formatRelativeDate } from "./SourceControlPanel.logic";
import { FileChangeList } from "./SourceControlPanelRows";

type BranchRenderers = ReturnType<typeof makeSourceControlPanelBranchRenderers>;

export function makeSourceControlPanelRepositoryRenderers(
  controller: ReadySourceControlPanelController,
  branchRenderers: BranchRenderers,
) {
  const {
    api,
    confirm,
    copyText,
    cwd,
    expandedTree,
    fileDiffListProps,
    isActionRunning,
    loadStashDetails,
    loadingStashDetails,
    openContextMenu,
    openFileChangeContextMenu,
    openInVsCode,
    runAction,
    snapshot,
    stashDetailsByKey,
    toggleFileDiff,
    toggleStashTree,
    toggleTree,
    toggleTreeFromKeyboard,
  } = controller;
  const { remoteBranchRow } = branchRenderers;
  const remoteRow = (remote: VcsPanelRemote) => {
    const key = treeKey("remote", remote.name);
    const expanded = expandedTree.has(key);
    const fetchKey = `remote-fetch:${remote.name}`;
    const removeKey = `remote-remove:${remote.name}`;
    const fetchRemote = () =>
      void runAction(
        fetchKey,
        () => api?.vcs.fetchRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
      );
    const removeRemote = () =>
      void (async () => {
        if (!(await confirm(`Remove remote ${remote.name}?`))) return;
        await runAction(
          removeKey,
          () => api?.vcs.removeRemote({ cwd, remoteName: remote.name }) ?? Promise.resolve(),
        );
      })();
    const remoteUrl = remote.fetchUrl ?? remote.pushUrl ?? "";
    return (
      <div key={remote.name} className="space-y-0.5">
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
                { id: "fetch", label: "Fetch remote", disabled: isActionRunning(fetchKey) },
                {
                  id: "remove",
                  label: "Remove remote",
                  destructive: true,
                  disabled: isActionRunning(removeKey),
                  icon: "trash",
                  separatorBefore: true,
                },
                { id: "copy-name", label: "Copy name", icon: "copy", separatorBefore: true },
                { id: "copy-url", label: "Copy url", disabled: !remoteUrl, icon: "copy" },
              ],
              {
                fetch: fetchRemote,
                remove: removeRemote,
                "copy-name": () => copyText(remote.name),
                "copy-url": () => copyText(remoteUrl, "Remote URL unavailable."),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-sm" />}>
              {remote.name}
            </TooltipTrigger>
            <RemoteTooltip remote={remote} />
          </Tooltip>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {remote.fetchUrl ?? "No fetch URL"}
          </span>
          <RowActions>
            <IconButton
              label="Fetch remote"
              disabled={isActionRunning(fetchKey)}
              loading={isActionRunning(fetchKey)}
              onClick={fetchRemote}
            >
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton
              label="Remove remote"
              destructive
              disabled={isActionRunning(removeKey)}
              loading={isActionRunning(removeKey)}
              onClick={removeRemote}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {expanded ? (
          <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
            {remote.branches.length === 0 ? (
              <div className="px-1.5 py-1 text-xs text-muted-foreground">No remote branches.</div>
            ) : (
              remote.branches.map((branch) => {
                const localBranch = localBranchForRemoteBranch(snapshot, remote, branch);
                return remoteBranchRow(
                  localBranch ?? remoteBranchRef(remote, branch),
                  branch.name,
                  localBranch !== null,
                );
              })
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const localBranchesRow = (branches: readonly VcsRef[]) => {
    const key = treeKey("unpublished", "local");
    const expanded = expandedTree.has(key);
    return (
      <div key="unpublished" className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent/60"
          onClick={() => toggleTree(key)}
          onKeyDown={(event) => toggleTreeFromKeyboard(key, event)}
          onContextMenu={(event) =>
            openContextMenu(event, [{ id: "copy-name", label: "Copy name", icon: "copy" }], {
              "copy-name": () => copyText("unpublished"),
            })
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">unpublished</span>
          <span className="min-w-0 flex-[2] truncate text-muted-foreground">
            {branches.length === 1 ? "1 branch" : `${branches.length} branches`}
          </span>
        </div>
        {expanded ? (
          <div className="ml-2 space-y-0.5 border-l border-border/60 pl-1">
            {branches.map((branch) => remoteBranchRow(branch, branch.name, true))}
          </div>
        ) : null}
      </div>
    );
  };

  const stashRow = (stash: VcsPanelStash) => {
    const stashKey = stashIdentityKey(stash);
    const key = treeKey("stash", stashKey);
    const expanded = expandedTree.has(key);
    const details = stashDetailsByKey.get(stashKey);
    const loadingDetails = loadingStashDetails.has(stashKey);
    const mutationKey = "stash-mutation";
    const mutationRunning = isActionRunning(mutationKey);
    const relativeDate = formatRelativeDate(stash.createdAt);
    const branchName = stashBranchName(stash);
    const applyStash = () =>
      void runAction(
        mutationKey,
        () => api?.vcs.applyStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
      );
    const popStash = () =>
      void runAction(
        mutationKey,
        () => api?.vcs.popStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
      );
    const dropStash = () =>
      void (async () => {
        if (!(await confirm(`Drop ${stash.refName}?`))) return;
        await runAction(
          mutationKey,
          () => api?.vcs.dropStash({ cwd, stashRef: stash.refName }) ?? Promise.resolve(),
        );
      })();
    return (
      <div key={stashKey} className="space-y-0.5">
        <div
          role="button"
          tabIndex={0}
          className="group relative flex h-7 min-w-0 cursor-pointer items-center justify-between gap-1.5 rounded px-1.5 text-xs hover:bg-accent/60"
          onClick={() => toggleStashTree(key, stash)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggleStashTree(key, stash);
          }}
          onContextMenu={(event) =>
            openContextMenu(
              event,
              [
                { id: "apply", label: "Apply stash", disabled: mutationRunning },
                { id: "pop", label: "Pop stash", disabled: mutationRunning },
                {
                  id: "drop",
                  label: "Drop stash",
                  destructive: true,
                  disabled: mutationRunning,
                  icon: "trash",
                  separatorBefore: true,
                },
                {
                  id: "copy-stash-name",
                  label: "Copy stash name",
                  icon: "copy",
                  separatorBefore: true,
                },
                {
                  id: "copy-branch-name",
                  label: "Copy branch name",
                  disabled: !branchName,
                  icon: "copy",
                },
              ],
              {
                apply: applyStash,
                pop: popStash,
                drop: dropStash,
                "copy-stash-name": () => copyText(stash.refName),
                "copy-branch-name": () => copyText(branchName ?? "", "Stash branch unavailable."),
              },
            )
          }
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <Archive className="size-3.5 shrink-0 text-muted-foreground" />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              {stash.message}
            </TooltipTrigger>
            <StashTooltip stash={stash} branchName={branchName} />
          </Tooltip>
          {relativeDate ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">{relativeDate}</span>
          ) : null}
          <span className="shrink-0 font-mono text-muted-foreground">{stash.refName}</span>
          <RowActions>
            <IconButton
              label="Apply stash"
              disabled={mutationRunning}
              loading={mutationRunning}
              onClick={applyStash}
            >
              <Download className="size-3.5" />
            </IconButton>
            <IconButton
              label="Pop stash"
              disabled={mutationRunning}
              loading={mutationRunning}
              onClick={popStash}
            >
              <Archive className="size-3.5" />
            </IconButton>
            <IconButton
              label="Drop stash"
              destructive
              disabled={mutationRunning}
              loading={mutationRunning}
              onClick={dropStash}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </RowActions>
        </div>
        {expanded && details ? (
          <div className="ml-2 border-l border-border/60 pl-1">
            <FileChangeList
              files={details.files}
              emptyLabel="No changes."
              onFileContextMenu={openFileChangeContextMenu}
              {...fileDiffListProps(() => ({ kind: "stash", stashRef: stash.refName }))}
            />
          </div>
        ) : null}
        {expanded && !details && loadingDetails ? (
          <div className="ml-2 border-l border-border/60 px-2 py-1 text-xs text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  };

  return { localBranchesRow, remoteRow, stashRow };
}
