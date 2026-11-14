import type { DiffPanelProps } from "./useDiffPanelState";
import { useDiffPanelStatePart1 } from "./useDiffPanelStatePart1";

import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { useStableCallback } from "../hooks/useStableCallback";
import type { ReviewBranchCommitsResult, ScopedThreadRef, RunId } from "@t3tools/contracts";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  Columns2Icon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";

import {
  AUTOMATIC_BASE_REF,
  DIFF_FILE_TREE_STORAGE_KEY,
  EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  getCachedFileEntry,
} from "./DiffPanelChrome";
import { Switch } from "./ui/switch";
import { DiffStatLabel } from "./chat/DiffStatLabel";import { RefreshIcon } from "~/components/ui/refresh-icon";
import { MorphIcon } from "~/components/MorphIcon";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
export function useDiffPanelStatePart2(props: DiffPanelProps, params: {
  s1: ReturnType<typeof useDiffPanelStatePart1>,
  }) {
  const { s1 } = params;
  const { settledFileCount, renderableFiles, loadNextFiles, shownFileEntries, lazySource, readyFilePaths, collapsedDiffFileKeys, isFileShown, shownFileKeys, sourceLineStat, renderableFileEntries, updateCollapsedDiffFiles, requestFile, selectedFilePath, collapseScopeKey, selectedFileRevealRequestId, routeThreadRef, activeCwd, activeRepositoryRoot, openInPreferredEditor, setCodeViewRevision, selectedTurn, selectedCommitSha, toolCallSelection, selectedRunId, selectedGitScope, latestTurn, orderedTurnDiffSummaries, headerCommitSha, selectedScopeLabel, selectedCommitUrl, openCommitUrl, settings, setOpenCommitMenu, branchCommitsQuery, branchCommits, activeProject, canReadFiles, fileAccess, canSelectBranchBase, comparisonHeadRef, comparisonBaseRef, baseRefItems, filteredBaseRefItems, selectedBaseRef, setBaseRefQuery, baseRefQuery, baseRefChoices, valueForBaseRefChoice, isGitSelection, selectedGitSource, canRefreshGitDiff, isRefreshingDiff, refreshDiffFromUserAction, diffFileKeys, diffLayout, wordWrap, setWordWrap, diffIgnoreWhitespace, setDiffIgnoreWhitespace, testFileCount, hideTestFiles, setHideTestFiles, fileTreeOpen, setFileTreeOpen } = s1;
    const renderLoadingBoundary = () =>
      settledFileCount < renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={loadNextFiles}
          count={renderableFiles.length - settledFileCount}
        />
      ) : null;
    const codeViewFiles = shownFileEntries
      .filter(
        ({ fileDiff }) =>
          !lazySource || !readyFilePaths || readyFilePaths.has(resolveFileDiffPath(fileDiff)),
      )
      .map(({ fileDiff, fileKey, fileVersion }) => ({
        fileDiff,
        filePath: resolveFileDiffPath(fileDiff),
        fileKey,
        fileVersion,
        collapsed:
          collapsedDiffFileKeys.has(fileKey) || fileDiff.cacheKey?.endsWith(":pending") === true,
      }));
    const pendingFiles = renderableFiles.filter(
      (file) => file.cacheKey?.endsWith(":pending") && isFileShown(file),
    );
    const allDiffFilesCollapsed = areAllDiffFilesCollapsed(shownFileKeys, collapsedDiffFileKeys);
    const diffLineStat = sourceLineStat ?? getDiffLineStat(renderableFiles);
    const fileTreeEntries = diffFileTreeEntries(renderableFiles.filter(isFileShown));
    const codeViewReveal = useCodeViewFileReveal();
    const revealDiffFile = (filePath: string) => {
      const index = renderableFileEntries.findIndex(
        (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
      );
      const file = renderableFileEntries[index];
      if (!file) return false;
      updateCollapsedDiffFiles((current) => {
        const next = new Set(current);
        next.delete(file.fileKey);
        return next;
      });
      if (lazySource && index >= settledFileCount) {
        requestFile(index);
      }
      codeViewReveal.request(file.fileKey);
      return true;
    };

    // A file another view asked to reveal (a chat diff link): retried as the diff loads until it
    // holds the file, then not again until a new request, so it does not undo what the user did since.
    const externalRevealRef = useRef<string | null>(null);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally requested file in the diff viewer, retrying as the diff DOM loads
    useEffect(() => {
      if (!selectedFilePath) {
        externalRevealRef.current = null;
        return;
      }
      const key = JSON.stringify([collapseScopeKey, selectedFilePath, selectedFileRevealRequestId]);
      if (externalRevealRef.current === key) return;
      if (revealDiffFile(selectedFilePath)) {
        externalRevealRef.current = key;
      }
    }, [collapseScopeKey, selectedFilePath, selectedFileRevealRequestId, revealDiffFile]);

    const openDiffFile = (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    };
    const toggleDiffFileCollapsed = useStableCallback((fileKey: string) => {
      updateCollapsedDiffFiles((current) => {
        const next = new Set(current);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return next;
      });
    });
    // Find can ask again before the unfolded file reaches the viewer, so this must never fold.
    const unfoldDiffFile = useStableCallback((fileKey: string) => {
      updateCollapsedDiffFiles((current) => {
        if (!current.has(fileKey)) return current;
        const next = new Set(current);
        next.delete(fileKey);
        return next;
      });
    });

    const toggleDiffFileCollapse = () => {
      setCodeViewRevision((current) => current + 1);
      updateCollapsedDiffFiles((current) => toggleAllDiffFiles(shownFileKeys, current));
    };

    const selectTurn = (runId: RunId) => {
      if (!routeThreadRef) return;
      useDiffPanelStore.getState().selectTurn(routeThreadRef, runId);
    };
    const selectGitScope = (scope: "branch" | "unstaged") => {
      if (!routeThreadRef) return;
      useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
    };
    const selectBranchBaseRef = (baseRef: string | null) => {
      if (!routeThreadRef) return;
      useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
    };
    const selectedTurnValue = selectedTurn ? `turn:${selectedTurn.runId}` : "";
    const selectedCommitValue = selectedCommitSha !== null ? `commit:${selectedCommitSha}` : "";
    const selectedScopeValue = toolCallSelection
      ? ""
      : selectedRunId === null
        ? selectedCommitValue || selectedGitScope
        : selectedTurn?.runId === latestTurn?.runId
          ? "latest"
          : selectedTurnValue;
    const selectScopeValue = (value: string) => {
      if (value === "unstaged" || value === "branch") {
        selectGitScope(value);
      } else if (value === selectedCommitValue) {
        selectGitScope("branch");
      } else if (value.startsWith("commit:")) {
        if (routeThreadRef) {
          useDiffPanelStore.getState().selectCommit(routeThreadRef, value.slice("commit:".length));
        }
      } else if (value === "latest") {
        if (latestTurn) selectTurn(latestTurn.runId);
      } else {
        const turn = orderedTurnDiffSummaries.find((summary) => `turn:${summary.runId}` === value);
        if (turn) selectTurn(turn.runId);
      }
    };

    const headerRow = (
      <>
        <div className="@container/diff-refs flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="xs" variant="secondary" />}
              className={cn("max-w-full", headerCommitSha !== null && "min-w-0 shrink")}
              aria-label={`Diff scope: ${selectedScopeLabel}`}
              data-workspace-focus-default
            >
              <span className="truncate">{selectedScopeLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            {headerCommitSha !== null ? (
              selectedCommitUrl ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <a
                        href={selectedCommitUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 font-mono text-xs text-muted-foreground underline underline-offset-4"
                        onClick={(event) => openCommitUrl(event, selectedCommitUrl)}
                      />
                    }
                  >
                    {headerCommitSha.slice(0, 7)}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{selectedCommitUrl}</TooltipPopup>
                </Tooltip>
              ) : (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {headerCommitSha.slice(0, 7)}
                </span>
              )
            ) : null}
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup value={selectedScopeValue} onValueChange={selectScopeValue}>
                <DropdownMenuRadioItem value="branch" closeOnClick>
                  <span>Changes</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unstaged" closeOnClick>
                  <span>Uncommitted</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="latest" closeOnClick>
                  <span>Latest turn</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={selectedTurnValue} onValueChange={selectScopeValue}>
                    {orderedTurnDiffSummaries.map((summary) => {
                      const turnCount = summary.checkpointTurnCount;
                      return (
                        <DropdownMenuRadioItem
                          key={summary.runId}
                          value={`turn:${summary.runId}`}
                          closeOnClick
                        >
                          <span className="flex items-center gap-2">
                            <span>Turn {turnCount}</span>
                            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                              {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                            </span>
                          </span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub
                onOpenChange={(open) => {
                  setOpenCommitMenu(open ? (branchCommitsQuery.data ?? null) : null);
                  if (!open) return;
                  // The menu keeps the list it opened with; the refreshed one shows next time.
                  branchCommitsQuery.refresh();
                }}
              >
                <DropdownMenuSubTrigger>Commits</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 max-w-96">
                  <DropdownMenuRadioGroup
                    value={selectedCommitValue}
                    onValueChange={selectScopeValue}
                  >
                    {branchCommits?.commits.map((commit) => {
                      const commitUrl = projectCommitUrl(
                        activeProject?.repositoryIdentity,
                        commit.sha,
                      );
                      return (
                        <div
                          key={commit.sha}
                          className={cn(
                            "flex items-center rounded-sm hover:bg-accent has-data-highlighted:bg-accent has-focus-visible:bg-accent [&_[data-checked]]:bg-transparent [&_[data-highlighted]]:bg-transparent",
                            selectedCommitSha === commit.sha && "bg-foreground/[0.08]",
                          )}
                        >
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <DropdownMenuRadioItem
                                  className="min-w-0 flex-1"
                                  value={`commit:${commit.sha}`}
                                  closeOnClick
                                />
                              }
                            >
                              <span className="flex items-center gap-3">
                                <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                  {formatRelativeTimeLabel(commit.committedAt)}
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipPopup side="right" className="max-w-80">
                              {commit.subject}
                            </TooltipPopup>
                          </Tooltip>
                          {commitUrl ? (
                            <DropdownMenuItem
                              className="shrink-0"
                              render={
                                <a
                                  href={commitUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={`Open commit ${commit.sha.slice(0, 7)}`}
                                />
                              }
                              onClick={(event) => openCommitUrl(event, commitUrl)}
                            >
                              <span className="font-mono text-xs text-muted-foreground underline underline-offset-4">
                                {commit.sha.slice(0, 7)}
                              </span>
                            </DropdownMenuItem>
                          ) : (
                            <span className="shrink-0 px-2 font-mono text-xs text-muted-foreground">
                              {commit.sha.slice(0, 7)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                  {branchCommitsQuery.error ? (
                    <DropdownMenuItem disabled>{branchCommitsQuery.error}</DropdownMenuItem>
                  ) : !canReadFiles ? (
                    <DropdownMenuItem disabled>
                      {fileAccess.isPending
                        ? "Checking file access..."
                        : (fileAccess.error ?? "This connection cannot read local diffs.")}
                    </DropdownMenuItem>
                  ) : branchCommits === null ? (
                    <DropdownMenuItem disabled>Loading commits...</DropdownMenuItem>
                  ) : branchCommits.commits.length === 0 ? (
                    <DropdownMenuItem disabled>No commits on this branch.</DropdownMenuItem>
                  ) : branchCommits.truncated ? (
                    <DropdownMenuItem disabled>
                      {`Showing latest ${branchCommits.commits.length} commits`}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          {canSelectBranchBase && (
            <div
              className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
              aria-label={`Comparing ${comparisonHeadRef} against ${comparisonBaseRef}`}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    // Too narrow for both refs, keep the target readable and drop the head, which
                    // is the thread's own branch.
                    <span className="flex min-w-[min(3rem,calc(100%-2.75rem))] items-center gap-2 overflow-hidden @max-[20rem]/diff-refs:hidden" />
                  }
                >
                  <span className="min-w-0 max-w-48 truncate">{comparisonHeadRef}</span>
                  <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {`${comparisonHeadRef} → ${comparisonBaseRef}`}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={<span aria-hidden className="hidden @max-[20rem]/diff-refs:inline" />}
                >
                  vs
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {`${comparisonHeadRef} → ${comparisonBaseRef}`}
                </TooltipPopup>
              </Tooltip>
              <Combobox
                items={baseRefItems}
                filteredItems={filteredBaseRefItems}
                value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
                onOpenChange={(open) => {
                  if (!open) setBaseRefQuery("");
                }}
                onValueChange={(value) => {
                  if (!value) return;
                  selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
                }}
              >
                <ComboboxTrigger
                  render={<Button variant="ghost-muted" size="xs" />}
                  className="min-w-9 max-w-48 shrink-0"
                  aria-label={`Change comparison target. Currently ${comparisonBaseRef}`}
                >
                  <span className="min-w-0 truncate">{comparisonBaseRef}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
                </ComboboxTrigger>
                <ComboboxPopup
                  align="start"
                  className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
                >
                  <ComboboxSearchInput
                    placeholder="Search refs..."
                    value={baseRefQuery}
                    onChange={(event) => setBaseRefQuery(event.target.value)}
                  />
                  <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
                    <span aria-hidden="true" />
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                      <span>Branch</span>
                      <span className="text-right">Remote</span>
                    </div>
                  </div>
                  <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                  <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                    <ComboboxItem
                      className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                      value={AUTOMATIC_BASE_REF}
                    >
                      <span className="block min-w-0 truncate">Automatic</span>
                    </ComboboxItem>
                    {baseRefChoices.map((choice) => {
                      const item = valueForBaseRefChoice(choice);
                      const hasBoth = choice.local !== null && choice.remote !== null;
                      const useRemote = choice.remote?.name === item;
                      return (
                        <ComboboxItem
                          key={choice.id}
                          className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                          value={item}
                        >
                          <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                            <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                            {hasBoth ? (
                              <div
                                className="flex justify-end"
                                onClick={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                <Switch
                                  aria-label={`Use remote version of ${choice.label}`}
                                  checked={useRemote}
                                  className="[--thumb-size:--spacing(3)]"
                                  onCheckedChange={(checked) => {
                                    const nextRef = checked
                                      ? choice.remote?.name
                                      : choice.local?.name;
                                    if (nextRef) selectBranchBaseRef(nextRef);
                                  }}
                                />
                              </div>
                            ) : choice.remote ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span className="flex justify-end text-muted-foreground">
                                      <CheckIcon
                                        role="img"
                                        aria-label="Remote only"
                                        className="size-3"
                                      />
                                    </span>
                                  }
                                />
                                <TooltipPopup side="top">Remote only</TooltipPopup>
                              </Tooltip>
                            ) : null}
                          </div>
                        </ComboboxItem>
                      );
                    })}
                  </ComboboxList>
                </ComboboxPopup>
              </Combobox>
            </div>
          )}
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]",
            headerCommitSha !== null && "gap-0",
          )}
        >
          {codeViewFiles.length > 0 || (isGitSelection && selectedGitSource?.files?.length) ? (
            <DiffStatLabel
              additions={diffLineStat.additions}
              deletions={diffLineStat.deletions}
              className="mr-1 text-2xs"
              layout="inline"
            />
          ) : null}
          {canRefreshGitDiff && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={isRefreshingDiff ? "Refreshing diff" : "Refresh diff"}
                    onClick={refreshDiffFromUserAction}
                  />
                }
              >
                <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {isRefreshingDiff ? "Refreshing diff…" : "Refresh diff"}
              </TooltipPopup>
            </Tooltip>
          )}
          {diffFileKeys.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                    onClick={toggleDiffFileCollapse}
                  />
                }
              >
                <MorphIcon
                  className="size-3.5"
                  icon={allDiffFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
              </TooltipPopup>
            </Tooltip>
          )}
          <ToggleGroup
            aria-label="Diff layout"
            className="shrink-0"
            variant="segmented"
            value={[diffLayout]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "stacked" || next === "split") {
                updateClientSettings({ diffLayout: next });
              }
            }}
          >
            <Toggle aria-label="Stacked diff view" value="stacked">
              <Rows3Icon className="size-3.5" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split">
              <Columns2Icon className="size-3.5" />
            </Toggle>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                  variant="ghost"
                  size="sm"
                  pressed={wordWrap}
                  onPressedChange={(pressed) => {
                    setWordWrap(Boolean(pressed));
                  }}
                />
              }
            >
              <TextWrapIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={
                    diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                  }
                  variant="ghost"
                  size="sm"
                  pressed={diffIgnoreWhitespace}
                  onPressedChange={(pressed) => {
                    setDiffIgnoreWhitespace(Boolean(pressed));
                  }}
                />
              }
            >
              <PilcrowIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            </TooltipPopup>
          </Tooltip>
          {testFileCount > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label="Hide test files"
                    variant="ghost"
                    size="sm"
                    pressed={hideTestFiles}
                    onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
                  />
                }
              >
                <FlaskConicalOffIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {hideTestFiles
                  ? `Show ${testFileCount} hidden test ${testFileCount === 1 ? "file" : "files"}`
                  : "Hide test files"}
              </TooltipPopup>
            </Tooltip>
          )}
          {diffFileKeys.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                    variant="ghost"
                    size="sm"
                    pressed={fileTreeOpen}
                    onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                  />
                }
              >
                <FolderTreeIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {fileTreeOpen ? "Hide file tree" : "Show file tree"}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
      </>
    );

  return { renderLoadingBoundary, codeViewFiles, pendingFiles, allDiffFilesCollapsed, diffLineStat, fileTreeEntries, codeViewReveal, revealDiffFile, externalRevealRef, openDiffFile, toggleDiffFileCollapsed, unfoldDiffFile, toggleDiffFileCollapse, selectTurn, selectGitScope, selectBranchBaseRef, selectedTurnValue, selectedCommitValue, selectedScopeValue, selectScopeValue, headerRow };
}
