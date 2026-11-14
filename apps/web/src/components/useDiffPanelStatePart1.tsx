import type { DiffPanelProps } from "./useDiffPanelState";

import { useRenderedAppearance } from "../hooks/useTheme";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "../hooks/useLocalStorage";

import {
  AUTOMATIC_BASE_REF,
  DIFF_FILE_TREE_STORAGE_KEY,
  EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  getCachedFileEntry,
} from "./DiffPanelChrome";
import * as Schema from "effect/Schema";
import { useHideTestFiles } from "./diffs/useHideTestFiles";
import type { ReviewBranchCommitsResult, ScopedThreadRef, RunId } from "@t3tools/contracts";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import {
  useProject,
  useThreadCheckpointSummaries,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../state/entities";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../state/server";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useAtomCommand } from "../state/use-atom-command";
import { reviewEnvironment } from "../state/review";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useCheckpointDiff, useTurnItemDetail } from "~/state/queries";
import { revisionedQuery } from "~/state/revisionedQuery";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import { useOpenLink } from "../browser/useOpenLink";
import { toolCallDiff } from "../lib/toolCallDiff";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { useStableCallback } from "../hooks/useStableCallback";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";

import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "../hooks/useLiveRefresh";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
export function useDiffPanelStatePart1(props: DiffPanelProps) {
    const { mode = "inline", composerDraftTarget, workspaceMutationId, visible } = props;
    const resolvedTheme = useRenderedAppearance();
    const settings = useClientSettings((settings) => ({
      diffFilesCollapsed: settings.diffFilesCollapsed,
      diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
      diffLayout: settings.diffLayout,
      timestampFormat: settings.timestampFormat,
      wordWrap: settings.wordWrap,
    }));
    const diffLayout = settings.diffLayout;
    const [wordWrap, setWordWrap] = useState(settings.wordWrap);
    const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
    const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
      DIFF_FILE_TREE_STORAGE_KEY,
      false,
      Schema.Boolean,
    );
    const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
    const [baseRefQuery, setBaseRefQuery] = useState("");
    // The open commit menu keeps the list it opened with, so rows do not move under the pointer.
    const [openCommitMenu, setOpenCommitMenu] = useState<ReviewBranchCommitsResult | null>(null);
    const [codeViewRevision, setCodeViewRevision] = useState(0);

    const routeThreadRef = useThreadRouteRef();
    const activeThreadId = routeThreadRef?.threadId ?? null;
    const activeThread = useQuietThreadShell(routeThreadRef);
    const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null);
    const { canReadFiles } = fileAccess;
    const activeProjectId = activeThread?.projectId ?? null;
    const activeProject = useProject(
      activeThread && activeProjectId
        ? {
            environmentId: activeThread.environmentId,
            projectId: activeProjectId,
          }
        : null,
    );
    const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
    const activeRepositoryRoot = activeThread?.worktreePath
      ? undefined
      : activeProject?.repositoryIdentity?.rootPath;
    const serverConfig = useAtomValue(
      serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
    );
    const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
    const openInPreferredEditor = useOpenInPreferredEditor(
      activeThread?.environmentId ?? null,
      serverConfig?.availableEditors ?? [],
    );
    const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
    const gitStatusQuery = useEnvironmentQuery(
      activeThread !== null && activeThread !== undefined && activeCwd != null
        ? vcsEnvironment.status({
            environmentId: activeThread.environmentId,
            input: { cwd: activeCwd },
          })
        : null,
    );
    const diffSelection = useDiffPanelStore((state) =>
      selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
    );
    const rememberedBaseRef = useDiffPanelStore((state) =>
      selectThreadBranchBaseRef(state, routeThreadRef),
    );
    const toolCallSelection = diffSelection.kind === "tool-call" ? diffSelection : null;
    const isGitSelection =
      diffSelection.kind === "branch" ||
      diffSelection.kind === "unstaged" ||
      diffSelection.kind === "commit";
    const toolCallItems = useQuietThreadVisibleTurnItems(toolCallSelection ? routeThreadRef : null);
    const toolCallDetail = useTurnItemDetail(
      toolCallSelection && routeThreadRef
        ? {
            ...resolveToolCallDiffTarget(toolCallSelection, toolCallItems),
            environmentId: routeThreadRef.environmentId,
          }
        : null,
    );
    const toolCallItem = toolCallDetail.data?.item;
    const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
    const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadRef);
    const orderedTurnDiffSummaries = turnDiffSummaries.toSorted((left, right) => {
      if (left.checkpointTurnCount !== right.checkpointTurnCount) {
        return right.checkpointTurnCount - left.checkpointTurnCount;
      }
      return right.completedAt.localeCompare(left.completedAt);
    });

    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rewrites the persisted diff store selection to the latest turn when the selected turn disappears
    useEffect(() => {
      if (!routeThreadRef || diffSelection.kind !== "turn") return;
      useDiffPanelStore.getState().reconcileTurnSelection(
        routeThreadRef,
        orderedTurnDiffSummaries.map((summary) => summary.runId),
      );
    }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

    const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
    const selectedGitScope =
      diffSelection.kind === "unstaged" || diffSelection.kind === "commit"
        ? diffSelection.kind
        : "branch";
    const selectedCommitSha = diffSelection.kind === "commit" ? diffSelection.sha : null;
    const selectedBaseRef =
      diffSelection.kind === "branch" || diffSelection.kind === "commit"
        ? diffSelection.baseRef
        : null;
    const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
    const selectedFileRevealRequestId =
      diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
    const selectedTurn =
      selectedRunId === null
        ? undefined
        : (orderedTurnDiffSummaries.find((summary) => summary.runId === selectedRunId) ??
          orderedTurnDiffSummaries[0]);
    const selectedCheckpointTurnCount = selectedTurn?.checkpointTurnCount;
    const latestTurn = orderedTurnDiffSummaries[0];
    const reviewSectionId = toolCallSelection
      ? `tool-call:${toolCallSelection.threadId}:${toolCallSelection.itemId}`
      : selectedTurn
        ? `turn:${selectedTurn.runId}`
        : selectedCommitSha !== null
          ? `commit:${selectedCommitSha}`
          : selectedGitScope;
    const collapseScopeKey = routeThreadRef
      ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
      : null;
    const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
    const selectedCheckpointRange =
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null;
    const activeCheckpointDiff = useCheckpointDiff(
      {
        environmentId: activeThread?.environmentId ?? null,
        threadId: activeThreadId,
        fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
        toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
        ignoreWhitespace: diffIgnoreWhitespace,
        cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
      },
      { enabled: isGitRepo && selectedTurn !== undefined },
    );
    const branchDiffPreviewInput =
      canReadFiles && isGitSelection && activeThread && activeCwd
        ? {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ...(selectedCommitSha !== null ? { commitSha: selectedCommitSha } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          }
        : undefined;
    const canRefreshGitDiff =
      isGitRepo && isGitSelection && activeThread != null && activeCwd != null;
    // Read under the workspace mutation id, so each mutation refetches the diff; the panel stays
    // mounted while hidden, so a mutation made then is already reflected when it shows.
    const branchDiffPreview = useEnvironmentQuery(
      branchDiffPreviewInput && activeThread
        ? revisionedQuery(
            reviewEnvironment.diffPreview({
              environmentId: activeThread.environmentId,
              input: branchDiffPreviewInput,
            }),
            canRefreshGitDiff ? workspaceMutationId : undefined,
          )
        : null,
    );
    const branchCommitsQuery = useEnvironmentQuery(
      visible && isGitRepo && canReadFiles && activeThread && activeCwd
        ? reviewEnvironment.branchCommits({
            environmentId: activeThread.environmentId,
            input: {
              cwd: activeCwd,
              ...(rememberedBaseRef ? { baseRef: rememberedBaseRef } : {}),
            },
          })
        : null,
    );
    const branchCommits = openCommitMenu ?? branchCommitsQuery.data;
    const activeThreadRefreshKey = routeThreadRef
      ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
      : null;

    const selectedGitSource = branchDiffPreview.data?.sources.find(
      (source) =>
        source.kind ===
        (selectedGitScope === "unstaged"
          ? "working-tree"
          : selectedGitScope === "commit"
            ? "commit"
            : "branch-range"),
    );
    const comparisonHeadRef = selectedGitSource?.headRef ?? gitStatusQuery.data?.refName ?? "HEAD";
    const comparisonBaseRef = selectedGitSource?.baseRef ?? selectedBaseRef ?? "Automatic";
    const selectedCommitSubject =
      selectedCommitSha !== null && selectedGitSource?.headRef === selectedCommitSha
        ? selectedGitSource.commitSubject
        : undefined;
    const selectedGitScopeLabel =
      selectedCommitSha !== null
        ? (selectedCommitSubject ?? `Commit ${selectedCommitSha.slice(0, 7)}`)
        : selectedGitScope === "unstaged"
          ? "Uncommitted"
          : "Changes";
    const selectedScopeLabel = toolCallSelection
      ? "Tool call"
      : selectedRunId === null
        ? selectedCommitSha !== null
          ? (selectedCommitSubject ?? "Commit")
          : selectedGitScopeLabel
        : selectedTurn?.runId === latestTurn?.runId
          ? "Latest turn"
          : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
    const reviewSectionTitle = toolCallSelection
      ? "Tool call"
      : selectedTurn
        ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
        : selectedGitScopeLabel;
    const headerCommitSha = selectedRunId === null ? selectedCommitSha : null;
    const selectedCommitUrl =
      headerCommitSha !== null
        ? projectCommitUrl(activeProject?.repositoryIdentity, headerCommitSha)
        : null;
    const openLink = useOpenLink(routeThreadRef);
    // A SHA link goes to the code host; it must not route back into this pane's commit selection.
    const openCommitUrl = (event: MouseEvent<HTMLElement>, url: string) => {
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button === 1)
        return;
      event.preventDefault();
      void openLink(url, { event });
    };
    const refreshPreviewQuery = branchDiffPreview.refresh;
    const refreshDiffFromUserAction = refreshPreviewQuery;

    const preview = branchDiffPreview.data;
    const gitDiff = selectedGitSource?.diff;

    const toolCallPreview =
      toolCallSelection && toolCallItem?.type === "file_change" ? toolCallDiff(toolCallItem) : null;
    const selectedPatch = toolCallSelection
      ? toolCallPreview?.patch
      : selectedTurn
        ? activeCheckpointDiff.data?.diff
        : gitDiff;
    const isSelectedPatchTruncated =
      toolCallPreview?.truncated === true ||
      (isGitSelection && selectedGitSource?.truncated === true);
    const selectedPatchQuery = toolCallSelection
      ? toolCallDetail
      : selectedTurn
        ? activeCheckpointDiff
        : branchDiffPreview;
    const isLoadingSelectedPatch = selectedPatchQuery.isPending && selectedPatchQuery.data === null;
    const selectedPatchError = toolCallSelection
      ? toolCallDetail.error
      : selectedTurn
        ? activeCheckpointDiff.error
        : branchDiffPreview.error;
    const hasResolvedPatch = typeof selectedPatch === "string";
    const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
    const lazySource =
      isGitSelection && selectedGitSource?.truncated && selectedGitSource.files
        ? selectedGitSource
        : null;
    const renderablePatch = getRenderablePatch(
      lazySource ? undefined : selectedPatch,
      `diff-panel:${resolvedTheme}`,
      {
        compactPartialHunkOffsets: isGitSelection,
        ...(toolCallSelection ? { ignoreWhitespace: diffIgnoreWhitespace } : {}),
      },
    );
    const recordedToolCallFileCount =
      toolCallSelection && toolCallItem?.type === "file_change"
        ? (toolCallItem.changes?.length ?? 0)
        : 0;
    const omittedToolCallFiles =
      renderablePatch?.kind === "files"
        ? Math.max(0, recordedToolCallFileCount - renderablePatch.files.length)
        : 0;
    const fileStats = new Map(lazySource?.files?.map((file) => [file.path, file]));
    const sourceLineStat =
      isGitSelection && selectedGitSource?.files
        ? selectedGitSource.files.reduce(
            (total, file) => ({
              additions: total.additions + file.additions,
              deletions: total.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : null;
    const currentLoadDiffFiles =
      isGitSelection && activeThread && preview && selectedGitSource && canReadFiles
        ? createGitDiffFileContentsLoader(getDiffFileContents, {
            environmentId: activeThread.environmentId,
            cwd: preview.cwd,
            sourceKind: selectedGitSource.kind,
            baseRef: selectedGitSource.baseRef,
            headRef: selectedGitSource.headRef,
            cacheKey: selectedGitSource.diffHash,
          })
        : undefined;
    const loadDiffFiles: FileDiffContentsLoader = useStableCallback(async (fileDiff) => {
      if (!currentLoadDiffFiles) {
        throw new Error("Diff file contents are unavailable for this selection.");
      }
      return currentLoadDiffFiles(fileDiff);
    });
    const canSelectBranchBase = canReadFiles && canRefreshGitDiff && selectedGitScope === "branch";
    const branchRefsCwd = branchDiffPreview.data?.cwd ?? activeCwd;
    const localBranchRefs = useEnvironmentQuery(
      canSelectBranchBase && activeThread && branchRefsCwd
        ? vcsEnvironment.listRefs({
            environmentId: activeThread.environmentId,
            input: {
              cwd: branchRefsCwd,
              includeMatchingRemoteRefs: true,
              refKind: "local",
              ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
              limit: 100,
            },
          })
        : null,
    );
    const remoteBranchRefs = useEnvironmentQuery(
      canSelectBranchBase && activeThread && branchRefsCwd
        ? vcsEnvironment.listRefs({
            environmentId: activeThread.environmentId,
            input: {
              cwd: branchRefsCwd,
              includeMatchingRemoteRefs: true,
              refKind: "remote",
              ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
              limit: 100,
            },
          })
        : null,
    );
    const baseRefChoices = buildBaseRefChoices(
      localBranchRefs.data?.refs.filter((ref) => ref.name !== comparisonHeadRef) ?? [],
      remoteBranchRefs.data?.refs ?? [],
    );
    const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
    const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
      selectedBaseRef && selectedBaseRef === choice.remote?.name
        ? selectedBaseRef
        : (choice.local?.name ?? choice.remote?.name ?? choice.id);
    const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
    const filteredBaseRefItems = [
      ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
      ...matchingBaseRefChoices.map(valueForBaseRefChoice),
    ];
    const {
      scope: filePatchScope,
      isPending: areFilePatchesPending,
      fileStates,
      retry,
      requestFile,
      readyFilePaths,
      renderableFiles,
      settledFileCount,
      loadNextFiles,
    } = useReviewFilePatches({
      environmentId: activeThread?.environmentId,
      cwd: branchDiffPreview.data?.cwd,
      source: lazySource,
      baseRef:
        selectedCommitSha !== null ? selectedBaseRef : (lazySource?.baseRef ?? selectedBaseRef),
      ignoreWhitespace: diffIgnoreWhitespace,
      theme: resolvedTheme,
      previewInput: branchDiffPreviewInput,
      preview: renderablePatch,
    });
    const refreshBranchDiffPreview = refreshPreviewQuery;
    const diffRefreshKey = `diff:${activeThreadRefreshKey ?? ""}`;

    // The panel stays mounted while hidden, and edits made outside T3 Code bump no mutation id, so
    // showing it revalidates the diff; that also stands in for focus events missed while hidden.
    // A git diff is too costly to repeat on a timer nobody asked for. A diff read within the floor,
    // such as a mutation's refetch while hidden, already counts as that revalidation.
    useLiveRefresh(
      branchDiffPreview.data !== null && !branchDiffPreview.isPending
        ? () => {
            if (Date.now() - branchDiffPreview.dataUpdatedAt < LIVE_REFRESH_MIN_INTERVAL_MS) return;
            refreshBranchDiffPreview();
          }
        : null,
      {
        enabled: visible && canReadFiles && canRefreshGitDiff,
        key: diffRefreshKey,
        intervalMs: null,
        refreshOnShow: true,
      },
    );

    const isRefreshingDiff = branchDiffPreview.isPending || areFilePatchesPending;
    const renderableFileEntries = renderableFiles.map(getCachedFileEntry);
    const diffFileKeys = renderableFileEntries.map((file) => file.fileKey);
    const testFileCount = renderableFiles.filter((file) =>
      isTestChangedFile(resolveFileDiffPath(file)),
    ).length;
    // Hiding is display-only: lazy loading indexes into the full list. A requested file stays visible.
    const isFileShown = (file: FileDiffMetadata) => {
      const path = resolveFileDiffPath(file);
      return !hideTestFiles || path === selectedFilePath || !isTestChangedFile(path);
    };
    const shownFileEntries = renderableFileEntries.filter(({ fileDiff }) => isFileShown(fileDiff));
    const shownFileKeys = shownFileEntries.map((file) => file.fileKey);
    const defaultCollapsedDiffFileKeys = settings.diffFilesCollapsed
      ? new Set(diffFileKeys)
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
    const storedCollapsedDiffFileKeys = useDiffPanelSessionStore((state) =>
      collapseScopeKey ? state.collapsedFileKeysByScopeKey[collapseScopeKey] : undefined,
    );
    const collapsedDiffFileKeys = storedCollapsedDiffFileKeys ?? defaultCollapsedDiffFileKeys;
    const updateCollapsedDiffFiles = (
      update: (current: ReadonlySet<string>) => ReadonlySet<string>,
    ) => {
      if (!collapseScopeKey) return;
      useDiffPanelSessionStore
        .getState()
        .updateCollapsedFileKeys(collapseScopeKey, defaultCollapsedDiffFileKeys, update);
    };

  return { composerDraftTarget, resolvedTheme, settings, diffLayout, wordWrap, setWordWrap, diffIgnoreWhitespace, setDiffIgnoreWhitespace, fileTreeOpen, setFileTreeOpen, hideTestFiles, setHideTestFiles, baseRefQuery, setBaseRefQuery, openCommitMenu, setOpenCommitMenu, codeViewRevision, setCodeViewRevision, routeThreadRef, activeThreadId, activeThread, fileAccess, canReadFiles, activeProjectId, activeProject, activeCwd, activeRepositoryRoot, serverConfig, onFileContextMenu, openInPreferredEditor, getDiffFileContents, gitStatusQuery, diffSelection, rememberedBaseRef, toolCallSelection, isGitSelection, toolCallItems, toolCallDetail, toolCallItem, isGitRepo, turnDiffSummaries, orderedTurnDiffSummaries, selectedRunId, selectedGitScope, selectedCommitSha, selectedBaseRef, selectedFilePath, selectedFileRevealRequestId, selectedTurn, selectedCheckpointTurnCount, latestTurn, reviewSectionId, collapseScopeKey, codeViewMountKey, selectedCheckpointRange, activeCheckpointDiff, branchDiffPreviewInput, canRefreshGitDiff, branchDiffPreview, branchCommitsQuery, branchCommits, activeThreadRefreshKey, selectedGitSource, comparisonHeadRef, comparisonBaseRef, selectedCommitSubject, selectedGitScopeLabel, selectedScopeLabel, reviewSectionTitle, headerCommitSha, selectedCommitUrl, openLink, openCommitUrl, refreshPreviewQuery, refreshDiffFromUserAction, preview, gitDiff, toolCallPreview, selectedPatch, isSelectedPatchTruncated, selectedPatchQuery, isLoadingSelectedPatch, selectedPatchError, hasResolvedPatch, hasNoNetChanges, lazySource, renderablePatch, recordedToolCallFileCount, omittedToolCallFiles, fileStats, sourceLineStat, currentLoadDiffFiles, loadDiffFiles, canSelectBranchBase, branchRefsCwd, localBranchRefs, remoteBranchRefs, baseRefChoices, matchingBaseRefChoices, valueForBaseRefChoice, baseRefItems, filteredBaseRefItems, filePatchScope, areFilePatchesPending, fileStates, retry, requestFile, readyFilePaths, renderableFiles, settledFileCount, loadNextFiles, refreshBranchDiffPreview, diffRefreshKey, isRefreshingDiff, renderableFileEntries, diffFileKeys, testFileCount, isFileShown, shownFileEntries, shownFileKeys, defaultCollapsedDiffFileKeys, storedCollapsedDiffFileKeys, collapsedDiffFileKeys, updateCollapsedDiffFiles };
}
