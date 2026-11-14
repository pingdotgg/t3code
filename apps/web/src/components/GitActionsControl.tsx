import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import { useGitActionsState } from "./git/useGitActionsState";
import type { GitActionsControlProps } from "./git/gitActionsTypes";

import { useRef } from "react";


import { cn } from "~/lib/utils";

import { StartTruncatedPath } from "./StartTruncatedPath";
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

import { Menu, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";

import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./chat/threadDetailsPanelStyles";

import { formatDiffCount } from "@t3tools/client-runtime/diff-count";

interface InlineGitActionSuccess {
  readonly title: string;
  readonly description: string | null;
  readonly scopeKey: string;
  readonly expiresAtMs: number;
}

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

const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

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
    <RunningGitActionElapsedTime startedAtMs={startedAtMs} className={className} />
  );
}

function RunningGitActionElapsedTime({
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
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
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
      <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
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
                <p className="truncate pt-0.5 text-left text-2xs font-normal text-muted-foreground" />
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

import { PublishRepositoryDialog } from "./git/PublishRepositoryDialog";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  SourceControlProviderKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  buildMenuItems,
  formatGitActionElapsed,
  GIT_ACTION_SUCCESS_VISIBLE_MS,
  type GitActionProgressPresentation,
  type GitActionIconName,
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
import { getSourceControlPresentation, sourceControlIcon } from "~/sourceControlPresentation";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  FileDiffIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
  LockIcon,
  GlobeIcon,
} from "lucide-react";
import { useNowSecond } from "../hooks/useNowSecond";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";


export default function GitActionsControl(props: GitActionsControlProps) {
  const {
    gitCwd,
    activeThreadRef,
    draftId,
    compact = false,
    showActions = true,
    showChanges = true,
    onOpenChanges,
  } = props;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
const s1 = useGitActionsState(props);
const { activeEnvironmentId, canWriteSourceControl, canOperateThread, canChangeThreadBranch, isCommitDialogOpen, setIsCommitDialogOpen, dialogCommitMessage, setDialogCommitMessage, excludedFiles, setExcludedFiles, isEditingFiles, setIsEditingFiles, isPublishDialogOpen, setIsPublishDialogOpen, pendingDefaultBranchAction, setPendingDefaultBranchAction, visibleInlineSuccess, refreshVcsStatus, SourceControlIcon, isRepo, gitStatusForActions, changesTotals, allFiles, workingTreeRoot, selectedFiles, allSelected, noneSelected, initAction, isGitActionRunning, isDefaultRef, quickAction, quickActionDisabledReason, gitActionProgress, quietEmptyDraft, pendingDefaultBranchActionCopy, featureBranchUnavailableReason, continuePendingDefaultBranchAction, runDialogActionOnNewBranch, runQuickAction, runDialogAction, openChangedFileInEditor, initializeGit, gitItems } = s1;

  if (!gitCwd) return null;

  return (
    <>
      {!showActions ? null : !isRepo ? (
        <ThreadDetailsControl
          size="xs"
          variant="ghost"
          part="row"
          panel
          disabled={!canWriteSourceControl || initAction.isPending}
          onClick={initializeGit}
        >
          <GitBranchPlusIcon className="size-3.5" aria-hidden />
          <span className={cn("ml-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {initAction.isPending ? "Initializing..." : "Initialize Git"}
          </span>
        </ThreadDetailsControl>
      ) : quietEmptyDraft || (compact && !gitActionProgress && !visibleInlineSuccess) ? null : (
        <div
          role="group"
          aria-label="Git actions"
          ref={panelAnchorRef}
          className={cn(
            "shrink-0",
            THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
            gitActionProgress && "bg-black/[0.035] dark:bg-white/[0.055]",
          )}
        >
          {gitActionProgress ? (
            <ThreadDetailsControl
              aria-label={
                gitActionProgress.output
                  ? `${gitActionProgress.status} ${gitActionProgress.output}`
                  : gitActionProgress.status
              }
              part="primary"
              panel
              multiline
              disabled
              size="xs"
              variant="ghost"
            >
              <GitActionProgressButtonContent progress={gitActionProgress} />
            </ThreadDetailsControl>
          ) : visibleInlineSuccess ? (
            <ThreadDetailsControl part="primary" multiline disabled size="xs" variant="ghost">
              <GitActionSuccessButtonContent success={visibleInlineSuccess} />
            </ThreadDetailsControl>
          ) : quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <ThreadDetailsControl
                    aria-disabled="true"
                    part="primary"
                    panel
                    size="xs"
                    variant="ghost"
                  />
                }
              >
                <GitQuickActionIcon
                  quickAction={quickAction}
                  SourceControlIcon={SourceControlIcon}
                  className={THREAD_DETAILS_PANEL_ICON_CLASS}
                />
                <span
                  className={cn(
                    "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                    cn("not-sr-only ml-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
                  )}
                >
                  {quickAction.label}
                </span>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <ThreadDetailsControl
              variant="ghost"
              size="xs"
              part="primary"
              panel
              disabled={!canWriteSourceControl || isGitActionRunning || quickAction.disabled}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon
                quickAction={quickAction}
                SourceControlIcon={SourceControlIcon}
                className={THREAD_DETAILS_PANEL_ICON_CLASS}
              />
              <span
                className={cn(
                  "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
                  cn("not-sr-only ml-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
                )}
              >
                {quickAction.label}
              </span>
            </ThreadDetailsControl>
          )}
          {gitActionProgress ? (
            <GitActionElapsedTime
              startedAtMs={gitActionProgress.startedAtMs}
              className="flex h-8 shrink-0 items-center self-start pe-2.5 text-2xs font-normal tabular-nums text-muted-foreground"
            />
          ) : (
            <>
              <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
              <Menu
                onOpenChange={(open) => {
                  if (open) {
                    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
                  }
                }}
              >
                <MenuTrigger
                  render={
                    <ThreadDetailsControl
                      aria-label="Git action options"
                      size="sm"
                      variant="ghost"
                      part="secondary"
                      panel
                    />
                  }
                  disabled={isGitActionRunning}
                >
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={THREAD_DETAILS_PANEL_CHEVRON_CLASS}
                  />
                </MenuTrigger>
                <MenuPopup align="end" anchor={panelAnchorRef} className="w-(--anchor-width)">
                  {gitItems}
                </MenuPopup>
              </Menu>
            </>
          )}
        </div>
      )}

      {showChanges && isRepo && !quietEmptyDraft ? (
        <ThreadDetailsControl
          type="button"
          variant="ghost"
          size="sm"
          part="row"
          disabled={!onOpenChanges}
          onClick={onOpenChanges}
        >
          <FileDiffIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
          <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Changes</span>
          <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
            <span
              className={
                changesTotals.insertions ? "text-diff-addition-foreground" : "text-muted-foreground"
              }
            >
              +{formatDiffCount(changesTotals.insertions)}
            </span>
            <span
              className={
                changesTotals.deletions ? "text-diff-deletion-foreground" : "text-muted-foreground"
              }
            >
              -{formatDiffCount(changesTotals.deletions)}
            </span>
          </span>
        </ThreadDetailsControl>
      ) : null}

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
          <DialogPanel>
            <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {gitStatusForActions?.refName ?? "(detached HEAD)"}
                  </span>
                  {isDefaultRef && <span className="text-right text-warning">Default branch</span>}
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
                    <div className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                      <ScrollArea>
                        <div className="space-y-1 p-1">
                          {allFiles.map((file) => {
                            const isExcluded = excludedFiles.has(file.path);
                            return (
                              <div
                                key={file.path}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
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
                                  className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left enabled:cursor-pointer"
                                  disabled={!canOperateThread || workingTreeRoot === null}
                                  aria-label={`Open ${file.path} in editor`}
                                  onClick={() => openChangedFileInEditor(file.path)}
                                >
                                  <StartTruncatedPath
                                    path={file.path}
                                    className={`flex-1${isExcluded ? " text-muted-foreground" : ""}`}
                                  />
                                  <span className="shrink-0">
                                    {isExcluded ? (
                                      <span className="text-muted-foreground">Excluded</span>
                                    ) : (
                                      <>
                                        <span className="text-diff-addition">
                                          +{formatDiffCount(file.insertions)}
                                        </span>
                                        <span className="text-muted-foreground"> / </span>
                                        <span className="text-diff-deletion">
                                          -{formatDiffCount(file.deletions)}
                                        </span>
                                      </>
                                    )}
                                  </span>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                    <div className="flex justify-end font-mono">
                      <span className="text-diff-addition">
                        +{formatDiffCount(selectedFiles.reduce((sum, f) => sum + f.insertions, 0))}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-diff-deletion">
                        -{formatDiffCount(selectedFiles.reduce((sum, f) => sum + f.deletions, 0))}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Commit message (optional)</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder="Leave empty to auto-generate"
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
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
              disabled={!canChangeThreadBranch || noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new branch
            </Button>
            <Button
              size="sm"
              disabled={!canWriteSourceControl || noneSelected}
              onClick={runDialogAction}
            >
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Its discovery query should stop when the Git actions row that opens it is hidden. */}
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
              <p className="text-xs text-muted-foreground">{featureBranchUnavailableReason}</p>
            )}
          </DialogHeader>
          <DialogFooter variant="bare" className="sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              Abort
            </Button>
            <Button
              className="w-full max-w-full sm:w-auto"
              variant="outline"
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
