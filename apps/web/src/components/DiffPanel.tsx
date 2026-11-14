import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ReviewBranchCommitsResult, ScopedThreadRef, RunId } from "@t3tools/contracts";
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
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import * as Schema from "effect/Schema";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { toolCallDiff } from "../lib/toolCallDiff";
import { useCheckpointDiff, useTurnItemDetail } from "~/state/queries";
import { revisionedQuery } from "~/state/revisionedQuery";
import { cn } from "~/lib/utils";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { useHideTestFiles } from "./diffs/useHideTestFiles";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "../hooks/useLiveRefresh";
import {
  useProject,
  useThreadCheckpointSummaries,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../state/entities";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { FileExplorerPane } from "./files/FileExplorerPane";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import { useOpenLink } from "../browser/useOpenLink";

type DiffThemeType = "light" | "dark";

import {
  DiffFileCollapseToggle,
  DiffFileHeaderSuffix,
} from "./DiffPanelChrome";
import { useDiffPanelState, type DiffPanelProps as DiffPanelStateProps } from "./useDiffPanelState";

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
  visible: boolean;
}


export default function DiffPanel(props: DiffPanelProps) {
  const { mode = "inline" } = props;
  const {
    activeCheckpointDiff,
    activeCwd,
    activeProject,
    activeProjectId,
    activeRepositoryRoot,
    activeThread,
    activeThreadId,
    activeThreadRefreshKey,
    allDiffFilesCollapsed,
    areFilePatchesPending,
    baseRefChoices,
    baseRefItems,
    baseRefQuery,
    branchCommits,
    branchCommitsQuery,
    branchDiffPreview,
    branchDiffPreviewInput,
    branchRefsCwd,
    canReadFiles,
    canRefreshGitDiff,
    canSelectBranchBase,
    codeViewFiles,
    codeViewMountKey,
    codeViewReveal,
    codeViewRevision,
    collapseScopeKey,
    collapsedDiffFileKeys,
    comparisonBaseRef,
    comparisonHeadRef,
    composerDraftTarget,
    currentLoadDiffFiles,
    defaultCollapsedDiffFileKeys,
    diffFileKeys,
    diffIgnoreWhitespace,
    diffLayout,
    diffLineStat,
    diffRefreshKey,
    diffSelection,
    externalRevealRef,
    fileAccess,
    filePatchScope,
    fileStates,
    fileStats,
    fileTreeEntries,
    fileTreeOpen,
    filteredBaseRefItems,
    getDiffFileContents,
    gitDiff,
    gitStatusQuery,
    hasNoNetChanges,
    hasResolvedPatch,
    headerCommitSha,
    headerRow,
    hideTestFiles,
    isFileShown,
    isGitRepo,
    isGitSelection,
    isLoadingSelectedPatch,
    isRefreshingDiff,
    isSelectedPatchTruncated,
    latestTurn,
    lazySource,
    loadDiffFiles,
    loadNextFiles,
    localBranchRefs,
    matchingBaseRefChoices,
    omittedToolCallFiles,
    onFileContextMenu,
    openCommitMenu,
    openCommitUrl,
    openDiffFile,
    openInPreferredEditor,
    openLink,
    orderedTurnDiffSummaries,
    pendingFiles,
    preview,
    readyFilePaths,
    recordedToolCallFileCount,
    refreshBranchDiffPreview,
    refreshDiffFromUserAction,
    refreshPreviewQuery,
    rememberedBaseRef,
    remoteBranchRefs,
    renderLoadingBoundary,
    renderableFileEntries,
    renderableFiles,
    renderablePatch,
    requestFile,
    resolvedTheme,
    retry,
    revealDiffFile,
    reviewSectionId,
    reviewSectionTitle,
    routeThreadRef,
    selectBranchBaseRef,
    selectGitScope,
    selectScopeValue,
    selectTurn,
    selectedBaseRef,
    selectedCheckpointRange,
    selectedCheckpointTurnCount,
    selectedCommitSha,
    selectedCommitSubject,
    selectedCommitUrl,
    selectedCommitValue,
    selectedFilePath,
    selectedFileRevealRequestId,
    selectedGitScope,
    selectedGitScopeLabel,
    selectedGitSource,
    selectedPatch,
    selectedPatchError,
    selectedPatchQuery,
    selectedRunId,
    selectedScopeLabel,
    selectedScopeValue,
    selectedTurn,
    selectedTurnValue,
    serverConfig,
    setBaseRefQuery,
    setCodeViewRevision,
    setDiffIgnoreWhitespace,
    setFileTreeOpen,
    setHideTestFiles,
    setOpenCommitMenu,
    setWordWrap,
    settings,
    settledFileCount,
    shownFileEntries,
    shownFileKeys,
    sourceLineStat,
    storedCollapsedDiffFileKeys,
    testFileCount,
    toggleDiffFileCollapse,
    toggleDiffFileCollapsed,
    toolCallDetail,
    toolCallItem,
    toolCallItems,
    toolCallPreview,
    toolCallSelection,
    turnDiffSummaries,
    unfoldDiffFile,
    updateCollapsedDiffFiles,
    valueForBaseRefChoice,
    wordWrap,
  } = useDiffPanelState(props);

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo && !toolCallSelection ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : isGitSelection && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="Checking file access..." />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {fileAccess.error ?? "This connection cannot read local diffs."}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
                {isGitSelection && selectedGitSource?.files ? " Totals include all changes." : ""}
              </p>
            )}
            {omittedToolCallFiles > 0 && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This tool call changed {recordedToolCallFileCount} files. The recorded patch omits{" "}
                {omittedToolCallFiles} of them.
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-2xs text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {!renderablePatch && toolCallPreview && toolCallPreview.content.length > 0 ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs">
                <p className="text-muted-foreground">
                  The provider recorded file content without a diff.
                </p>
                {toolCallPreview.content.map(({ label, text }) => (
                  <div key={label} className="space-y-1">
                    <p className="text-muted-foreground">{label}</p>
                    <pre
                      className={cn(
                        "overflow-auto font-mono text-2xs",
                        wordWrap && "whitespace-pre-wrap wrap-break-word",
                      )}
                    >
                      {text === "" ? "Empty content." : text}
                    </pre>
                  </div>
                ))}
              </div>
            ) : !renderablePatch && !lazySource ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    toolCallSelection
                      ? "Loading tool call diff..."
                      : selectedTurn
                        ? "Loading checkpoint diff..."
                        : selectedGitScope === "unstaged"
                          ? "Loading uncommitted changes..."
                          : selectedGitScope === "commit"
                            ? "Loading commit..."
                            : "Loading changes..."
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : lazySource || renderablePatch?.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    for (const node of composedPath) {
                      if (!(node instanceof HTMLElement)) continue;
                      // Header buttons own their clicks; bubbling a chevron click would toggle twice.
                      if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                        return;
                      }
                    }
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent;
                    if (filePath) {
                      openDiffFile(filePath);
                      return;
                    }
                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    const headerFilePath = header?.querySelector("[data-title]")?.textContent;
                    if (!headerFilePath) return;
                    const file = codeViewFiles.find(
                      (candidate) => candidate.filePath === headerFilePath,
                    );
                    if (file) toggleDiffFileCollapsed(file.fileKey);
                  }}
                  onContextMenuCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (!filePath) return;
                    event.preventDefault();
                    onFileContextMenu(
                      {
                        environmentId: activeThread?.environmentId ?? null,
                        filePath,
                        workspaceRoot: activeCwd,
                        repositoryRoot: activeRepositoryRoot,
                      },
                      event,
                    );
                  }}
                >
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={codeViewReveal.attach}
                    codeViewKey={`${codeViewMountKey}:${lazySource ? filePatchScope : "preview"}`}
                    className="h-full min-h-0 overflow-auto"
                    files={codeViewFiles}
                    pendingFiles={pendingFiles}
                    renderCodeViewFooter={renderLoadingBoundary}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    renderHeaderFilenameSuffix={(fileDiff) => {
                      const path = resolveFileDiffPath(fileDiff);
                      const state = fileStates.get(path);
                      return (
                        <DiffFileHeaderSuffix
                          filePath={path}
                          hasStat={fileStats.has(path)}
                          error={state?.error ?? false}
                          truncated={state?.truncated ?? false}
                          onRetry={retry}
                        />
                      );
                    }}
                    {...(lazySource
                      ? {
                          unsafeCSSExtra:
                            "[data-additions-count], [data-deletions-count] { display: none; }",
                          renderHeaderMetadata: (fileDiff: FileDiffMetadata) => {
                            const stat = fileStats.get(resolveFileDiffPath(fileDiff));
                            return stat ? (
                              <DiffStatLabel
                                additions={stat.additions}
                                deletions={stat.deletions}
                              />
                            ) : null;
                          },
                        }
                      : {})}
                    onRevealSearchMatch={unfoldDiffFile}
                    renderHeaderPrefix={(fileDiff, fileKey) => {
                      const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
                      return (
                        <DiffFileCollapseToggle
                          filePath={resolveFileDiffPath(fileDiff)}
                          fileKey={fileKey}
                          collapsed={unavailable || collapsedDiffFileKeys.has(fileKey)}
                          unavailable={unavailable}
                          onToggle={toggleDiffFileCollapsed}
                        />
                      );
                    }}
                    options={{
                      diffStyle: diffLayout === "split" ? "split" : "unified",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      onPostRender: codeViewReveal.flush,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <FileExplorerPane
                    resizable
                    storageKey="t3code:diff-file-tree-width"
                    defaultWidthFraction={0.4}
                    resizeLabel="Resize Changes files"
                  >
                    <DiffFileTree
                      ariaLabel={`${reviewSectionTitle} files`}
                      entries={fileTreeEntries}
                      selectedPath={selectedFilePath}
                      revealRequestId={selectedFileRevealRequestId}
                      onSelectFile={revealDiffFile}
                    />
                  </FileExplorerPane>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-2xs text-muted-foreground/75">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
