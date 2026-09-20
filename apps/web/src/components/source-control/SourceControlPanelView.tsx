import { useAtomValue } from "@effect/atom-react";
import { FileDiff, useWorkerPool } from "@pierre/diffs/react";
import {
  ChevronDown,
  Copy,
  GitBranch,
  GitCommit,
  GitPullRequestArrow,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

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
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  readCachedSourceControlPanelState,
  sourceControlPanelStateCacheKey,
  writeCachedSourceControlPanelState,
  type SourceControlSectionKey,
} from "./SourceControlPanelCache";
import {
  COMMIT_PAGE_SIZE,
  MIN_SECTION_WEIGHT,
  SECTION_ORDER,
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
  splitEnrichmentFileKey,
  treeKey,
  worktreeChangeSetId,
  commitCountLabel,
  type FileDiffLoadState,
  type SectionKey,
} from "./SourceControlPanelModel";
import {
  AttentionIcon,
  BranchSyncLabels,
  CommitTooltip,
  CompactBadge,
  IconButton,
  RemoteTooltip,
  StashTooltip,
  StatLabels,
  WorkingTreeTooltip,
  stashActivityTimestamp,
} from "./SourceControlPanelPrimitives";
import { makeSourceControlPanelBranchRenderers } from "./SourceControlPanelBranches";
import { BranchBadge, CollapsibleSection } from "./SourceControlPanelRows";
import { LoaderCircle, Upload } from "lucide-react";
import { TooltipPopup } from "../ui/tooltip";
import { makeSourceControlPanelRepositoryRenderers } from "./SourceControlPanelRepositories";
import { makeSourceControlPanelWorkingTreeRenderers } from "./SourceControlPanelWorkingTree";
import type {
  ReadySourceControlPanelController,
  SourceControlPanelController,
} from "./useSourceControlPanelController";

export function SourceControlPanelView({
  controller,
  repositoryAction,
}: {
  readonly controller: SourceControlPanelController;
  readonly repositoryAction?: ReactNode;
}) {
  const {
    addRemoteOpen,
    api,
    branchDetailsByRef,
    changedFiles,
    chooseCompareBase,
    collapsed,
    commitDialogOpen,
    commitMessageId,
    compareBaseOverrides,
    compareBaseRefs,
    compareBaseDialogTarget,
    compareBaseQuery,
    copyText,
    closeCreateBranchDialog,
    createBranchCommitTarget,
    createBranchName,
    cwd,
    dialogCommitMessage,
    dialogStashMessage,
    divergedSyncBranch,
    error,
    filteredCompareBaseRefs,
    containerRef,
    fetchActionableBranches,
    gitAction,
    isActionRunning,
    loading,
    presentationState,
    publishBranch,
    publishRemoteTarget,
    refresh,
    remoteName,
    remoteUrl,
    runAction,
    runCreateBranchFromCommit,
    runDivergedSync,
    runGeneratedPanelStash,
    runPanelCommit,
    runPanelStash,
    sectionWeights,
    setAddRemoteOpen,
    setCommitDialogOpen,
    setCompareBaseDialogTarget,
    setCompareBaseQuery,
    setCreateBranchName,
    setDialogCommitMessage,
    setDialogStashMessage,
    setDivergedSyncBranch,
    setPublishRemoteTarget,
    setRemoteName,
    setRemoteUrl,
    setStashDialogTarget,
    selectedChangedFiles,
    snapshot,
    stashDialogTarget,
    stashMessageId,
    startSectionResize,
    toggleSection,
  } = controller;
  const section = (key: SectionKey, children: ReactNode, action?: ReactNode) => (
    <CollapsibleSection
      key={key}
      sectionKey={key}
      title={SECTION_TITLES[key]}
      collapsed={collapsed.has(key)}
      weight={sectionWeights[key]}
      onToggle={() => toggleSection(key)}
      onResizeStart={startSectionResize}
      action={action}
    >
      {children}
    </CollapsibleSection>
  );

  if (presentationState.status === "loading") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        {presentationState.message}
      </div>
    );
  }

  if (presentationState.status === "unavailable") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        <div className="relative rounded border border-destructive/35 bg-destructive/10 py-2 pl-2 pr-9 text-xs text-destructive-foreground">
          <div className="max-h-20 overflow-auto whitespace-pre-wrap break-words">
            {presentationState.message}
          </div>
          <div className="absolute right-1 top-1">
            <IconButton
              label="Copy error"
              disabled={!presentationState.canCopyError}
              onClick={() => copyText(error ?? "", "No error to copy.")}
            >
              <Copy className="size-3.5" />
            </IconButton>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
    );
  }

  if (!snapshot) {
    return null;
  }

  const readyController: ReadySourceControlPanelController = { ...controller, snapshot };
  const branchRenderers = makeSourceControlPanelBranchRenderers(readyController);
  const { branchRow } = branchRenderers;
  const { localBranchesRow, remoteRow, stashRow } = makeSourceControlPanelRepositoryRenderers(
    readyController,
    branchRenderers,
  );
  const { localBranchesWithoutUpstream, renderWorkingTreeRow, workItems } =
    makeSourceControlPanelWorkingTreeRenderers(readyController);
  const showRefreshSpinner =
    loading && presentationState.status === "ready" && presentationState.syncMessage !== null;
  const syncBannerMessage = showRefreshSpinner ? null : presentationState.syncMessage;
  const repositorySummary = (
    <div className="relative shrink-0 border-b border-border/70 px-2 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate font-medium">
            {snapshot.status.refName ?? "Detached HEAD"}
          </span>
          <BranchBadge snapshot={snapshot} />
        </div>
        {showRefreshSpinner ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={presentationState.syncMessage ?? "Refreshing repository state..."}
                  className="inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                </span>
              }
            />
            <TooltipPopup side="left">{presentationState.syncMessage}</TooltipPopup>
          </Tooltip>
        ) : null}
        {repositoryAction ? <div className="ml-auto shrink-0">{repositoryAction}</div> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>
          {changedFiles.length > 0
            ? changedFiles.length === 1
              ? "1 file"
              : `${changedFiles.length} files`
            : "Clean"}
        </span>
        <StatLabels
          insertions={snapshot.status.workingTree.insertions}
          deletions={snapshot.status.workingTree.deletions}
        />
        {snapshot.status.aheadOfDefaultCount ? (
          <span>{snapshot.status.aheadOfDefaultCount} ahead of default</span>
        ) : null}
      </div>
      {syncBannerMessage ? (
        <div
          className={cn(
            "relative mt-1 rounded border py-1.5 pl-2 pr-8",
            error
              ? "border-destructive/35 bg-destructive/10 text-destructive-foreground"
              : "border-border/70 bg-muted/45 text-muted-foreground",
          )}
        >
          <div className="max-h-20 overflow-auto whitespace-pre-wrap break-words">
            {syncBannerMessage}
          </div>
          <div className="absolute right-1 top-1">
            <IconButton
              label="Copy status"
              disabled={!error}
              onClick={() => copyText(error ?? "", "No error to copy.")}
            >
              <Copy className="size-3.5" />
            </IconButton>
          </div>
        </div>
      ) : null}
    </div>
  );

  const workSection = (
    <div className="space-y-0.5">
      {workItems.length === 0 ? (
        <div className="px-1.5 py-1 text-xs text-muted-foreground/70">
          Everything is up-to-date.
        </div>
      ) : (
        workItems.map((item) => {
          switch (item.kind) {
            case "working-tree":
              return <div key={item.key}>{renderWorkingTreeRow(item.changeSet)}</div>;
            case "branch":
              return branchRow(item.branch);
            case "fork-branch": {
              const fetchKey = `fork-fetch:${item.fork.localBranchName}:${item.fork.remoteRefName}`;
              const detailsKey = treeKey(
                "fork-details",
                `${item.fork.localBranchName}:${item.fork.remoteRefName}`,
              );
              return branchRow(item.branch, {
                key: treeKey(
                  "fork-branch",
                  `${item.fork.localBranchName}:${item.fork.remoteRefName}`,
                ),
                detailsKey,
                compareBaseRef: item.fork.remoteRefName,
                syncCounts: {
                  aheadCount: item.fork.aheadCount,
                  behindCount: item.fork.behindCount,
                },
                attention: "behind",
                syncLabel: "Fetch",
                syncState: "fetch",
                syncActionKey: fetchKey,
                fetchActionKey: fetchKey,
                secondaryBadge: <CompactBadge>vs {item.fork.remoteRefName}</CompactBadge>,
                onSync: () =>
                  void runAction(
                    fetchKey,
                    () =>
                      api?.vcs.fetchBranch({
                        cwd,
                        branchName: item.fork.remoteRefName,
                      }) ?? Promise.resolve(),
                  ),
              });
            }
            case "stash":
              return stashRow(item.stash);
          }
        })
      )}
    </div>
  );

  const remotesSection = (
    <div className="space-y-0.5">
      {localBranchesWithoutUpstream.length > 0
        ? localBranchesRow(localBranchesWithoutUpstream)
        : null}
      {snapshot.remotes.length === 0 && localBranchesWithoutUpstream.length === 0 ? (
        <div className="text-sm text-muted-foreground">No remotes configured.</div>
      ) : (
        snapshot.remotes.map(remoteRow)
      )}
    </div>
  );

  return (
    <>
      <TooltipProvider delay={150} closeDelay={0} timeout={400}>
        <div
          data-source-control-tooltip-boundary
          className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
        >
          {repositorySummary}
          <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {SECTION_ORDER.map((key) => {
              switch (key) {
                case "work":
                  return section(
                    key,
                    workSection,
                    <IconButton
                      label="Fetch"
                      disabled={isActionRunning("work-fetch")}
                      loading={isActionRunning("work-fetch")}
                      onClick={() => void fetchActionableBranches(true)}
                    >
                      <RefreshCw className="size-3.5" />
                    </IconButton>,
                  );
                case "remotes":
                  return section(
                    key,
                    remotesSection,
                    <div className="flex items-center gap-0.5">
                      <IconButton
                        label="Fetch all remotes"
                        disabled={isActionRunning("remotes-fetch-all")}
                        loading={isActionRunning("remotes-fetch-all")}
                        onClick={() =>
                          void runAction("remotes-fetch-all", async () => {
                            await api?.vcs.fetchAllRemotes({ cwd, force: true });
                          })
                        }
                      >
                        <RefreshCw className="size-3.5" />
                      </IconButton>
                      <IconButton label="Add remote" onClick={() => setAddRemoteOpen(true)}>
                        <Plus className="size-3.5" />
                      </IconButton>
                    </div>,
                  );
              }
            })}
          </div>
        </div>
      </TooltipProvider>
      <Dialog
        open={createBranchCommitTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeCreateBranchDialog();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>
              Create a branch from {createBranchCommitTarget?.shortSha ?? "this commit"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              size="sm"
              value={createBranchName}
              placeholder="feature/my-branch"
              aria-label="Branch name"
              disabled={isActionRunning(
                `commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`,
              )}
              onChange={(event) => setCreateBranchName(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={closeCreateBranchDialog}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                !createBranchName.trim() ||
                isActionRunning(`commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`)
              }
              onClick={() => void runCreateBranchFromCommit()}
            >
              {isActionRunning(`commit-create-branch:${createBranchCommitTarget?.sha ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Create
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={addRemoteOpen} onOpenChange={setAddRemoteOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add remote</DialogTitle>
            <DialogDescription>Register a Git remote for this repository.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              size="sm"
              value={remoteName}
              placeholder="origin"
              aria-label="Remote name"
              onChange={(event) => setRemoteName(event.currentTarget.value)}
            />
            <Input
              size="sm"
              value={remoteUrl}
              placeholder="git@github.com:owner/repo.git"
              aria-label="Remote URL"
              onChange={(event) => setRemoteUrl(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAddRemoteOpen(false);
                setRemoteName("");
                setRemoteUrl("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                isActionRunning("remote-add") ||
                remoteName.trim().length === 0 ||
                remoteUrl.trim().length === 0
              }
              onClick={() =>
                void runAction("remote-add", async () => {
                  if (!api) return;
                  await api.vcs.addRemote({ cwd, name: remoteName.trim(), url: remoteUrl.trim() });
                  setRemoteName("");
                  setRemoteUrl("");
                  setAddRemoteOpen(false);
                })
              }
            >
              {isActionRunning("remote-add") ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Add
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={publishRemoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPublishRemoteTarget(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Publish branch</DialogTitle>
            <DialogDescription>
              Choose the remote to set as upstream for{" "}
              {publishRemoteTarget?.branch.name ?? "this branch"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-1">
            {snapshot.remotes.map((remote) => (
              <button
                key={remote.name}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  const target = publishRemoteTarget;
                  setPublishRemoteTarget(null);
                  if (!target) return;
                  void publishBranch(target.branch, remote.name, target.force);
                }}
              >
                <Upload className="size-3.5 shrink-0 text-success-foreground" />
                <span className="min-w-0 flex-1 truncate">{remote.name}</span>
                <span className="min-w-0 flex-[2] truncate text-xs text-muted-foreground">
                  {remote.fetchUrl ?? "No fetch URL"}
                </span>
              </button>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPublishRemoteTarget(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={compareBaseDialogTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          setCompareBaseDialogTarget(null);
          setCompareBaseQuery("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Choose compare base</DialogTitle>
            <DialogDescription>
              Select the ref to compare with {compareBaseDialogTarget?.branch.name ?? "this branch"}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Combobox
              items={compareBaseRefs}
              filteredItems={filteredCompareBaseRefs}
              autoHighlight
              value={
                compareBaseDialogTarget
                  ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
                    compareBaseOverrides.get(compareBaseDialogTarget.detailsKey) ??
                    "")
                  : ""
              }
              onOpenChange={(open) => {
                if (!open) setCompareBaseQuery("");
              }}
            >
              <ComboboxTrigger render={<Button variant="outline" size="sm" />}>
                <GitBranch className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {compareBaseDialogTarget
                    ? (branchDetailsByRef.get(compareBaseDialogTarget.detailsKey)?.baseRef ??
                      compareBaseOverrides.get(compareBaseDialogTarget.detailsKey) ??
                      "Choose ref")
                    : "Choose ref"}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup className="flex w-80 flex-col">
                <div className="shrink-0 px-3 pt-2.5">
                  <ComboboxInput
                    size="sm"
                    placeholder="Search refs..."
                    showTrigger={false}
                    value={compareBaseQuery}
                    onChange={(event) => setCompareBaseQuery(event.currentTarget.value)}
                  />
                </div>
                <ComboboxEmpty>No refs found.</ComboboxEmpty>
                <ComboboxList className="max-h-56">
                  {filteredCompareBaseRefs.map((refName) => (
                    <ComboboxItem
                      hideIndicator
                      key={refName}
                      value={refName}
                      onClick={() => chooseCompareBase(refName)}
                    >
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{refName}</span>
                      </div>
                    </ComboboxItem>
                  ))}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCompareBaseDialogTarget(null);
                setCompareBaseQuery("");
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={divergedSyncBranch !== null}
        onOpenChange={(open) => {
          if (!open) setDivergedSyncBranch(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Sync diverged branch</DialogTitle>
            <DialogDescription>
              Choose how to reconcile local and upstream commits for{" "}
              {divergedSyncBranch?.name ?? "this branch"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setDivergedSyncBranch(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`)}
              onClick={() => runDivergedSync("force-pull")}
            >
              {isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Force pull
            </Button>
            <Button
              size="sm"
              disabled={
                isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ||
                divergedSyncBranch?.current !== true
              }
              onClick={() => runDivergedSync("merge")}
            >
              {isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Merge sync
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`)}
              onClick={() => runDivergedSync("force-push")}
            >
              {isActionRunning(`branch-sync:${divergedSyncBranch?.name ?? ""}`) ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Force push
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Commit selected changes</DialogTitle>
            <DialogDescription>
              Provide a message, or leave it blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block text-sm font-medium" htmlFor={commitMessageId}>
              Commit message (optional)
            </label>
            <Textarea
              id={commitMessageId}
              size="sm"
              value={dialogCommitMessage}
              placeholder="Leave empty to auto-generate"
              aria-label="Commit message (optional)"
              disabled={isActionRunning("changes-commit") || gitAction.isPending}
              onChange={(event) => setDialogCommitMessage(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCommitDialogOpen(false);
                setDialogCommitMessage("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                selectedChangedFiles.length === 0 ||
                isActionRunning("changes-commit") ||
                gitAction.isPending
              }
              onClick={() => void runPanelCommit(dialogCommitMessage)}
            >
              {isActionRunning("changes-commit") || gitAction.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={stashDialogTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          setStashDialogTarget(null);
          setDialogStashMessage("");
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Stash {stashDialogTarget?.label ?? ""} changes</DialogTitle>
            <DialogDescription>
              Provide a message, or leave it blank to auto-generate one.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block text-sm font-medium" htmlFor={stashMessageId}>
              Stash message (optional)
            </label>
            <Textarea
              id={stashMessageId}
              size="sm"
              value={dialogStashMessage}
              placeholder="Leave empty to auto-generate"
              aria-label="Stash message (optional)"
              disabled={isActionRunning("changes-stash")}
              onChange={(event) => setDialogStashMessage(event.currentTarget.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStashDialogTarget(null);
                setDialogStashMessage("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isActionRunning("changes-stash") || !stashDialogTarget}
              onClick={runPanelStash}
            >
              {isActionRunning("changes-stash") ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              Stash
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
