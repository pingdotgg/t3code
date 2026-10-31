import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ReviewBranchCommitsResult, ScopedThreadRef, RunId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  FileCheckIcon,
  FileDiffIcon,
  FolderGit2Icon,
  HistoryIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide";
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
  getDiffCollapseIconClassName,
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
import { useClientSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { PanelEmptyState } from "./PanelEmptyState";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { FileExplorerPane } from "./files/FileExplorerPane";
import { DiffViewControls } from "./diffs/DiffViewControls";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { Button, InlineButton } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
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
  DropdownMenuSeparator,
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
import { Text } from "./ui/text";
import { DiffReviewTray } from "./diffs/DiffReviewTray";
import {
  DiffFileBasename,
  DiffFileChangeIcon,
  DiffFileHeaderStat,
  diffHeaderTitlePath,
  fileDiffLineStat,
} from "./diffs/DiffFileHeaderParts";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  { fileDiff: FileDiffMetadata; fileKey: string; fileVersion: number }
>();

function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  unavailable,
  iconClassName,
  onToggle,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  unavailable: boolean;
  iconClassName: string;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            disabled={unavailable}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        <MorphIcon
          className={cn("size-4", iconClassName)}
          icon={collapsed ? ChevronRight : ChevronDown}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}

function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
  visible: boolean;
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  workspaceMutationId,
  visible,
}: DiffPanelProps) {
  const resolvedTheme = useRenderedAppearance();
  const now = useNowMinute();
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
  // The comments written here since the review tray was last dismissed, for its one-press Undo.
  // Tied to the draft they went into, so switching threads does not carry a batch across.
  const composerDraftKey =
    typeof composerDraftTarget === "string"
      ? composerDraftTarget
      : scopedThreadKey(composerDraftTarget);
  const [reviewBatch, setReviewBatch] = useState<{
    draftKey: string;
    commentIds: ReadonlyArray<string>;
  } | null>(null);
  const reviewBatchIds = reviewBatch?.draftKey === composerDraftKey ? reviewBatch.commentIds : [];
  const addToReviewBatch = (commentId: string) =>
    setReviewBatch((current) => ({
      draftKey: composerDraftKey,
      commentIds:
        current?.draftKey === composerDraftKey ? [...current.commentIds, commentId] : [commentId],
    }));
  const dismissReviewBatch = () => setReviewBatch(null);

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
        ? "Working tree"
        : "Branch changes";
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
            render={<Button size="xs" variant="ghost" />}
            className={cn("max-w-full", headerCommitSha !== null && "min-w-0 shrink")}
            aria-label={`Diff scope: ${selectedScopeLabel}`}
            data-workspace-focus-default
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          {headerCommitSha !== null ? (
            selectedCommitUrl ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InlineButton
                      tone="muted"
                      className="shrink-0"
                      render={
                        <a href={selectedCommitUrl} target="_blank" rel="noopener noreferrer" />
                      }
                      onClick={(event) => openCommitUrl(event, selectedCommitUrl)}
                    />
                  }
                >
                  <Text variant="meta" mono>
                    {headerCommitSha.slice(0, 7)}
                  </Text>
                </TooltipTrigger>
                <TooltipPopup side="top">{selectedCommitUrl}</TooltipPopup>
              </Tooltip>
            ) : (
              <span className="shrink-0 font-mono text-meta text-muted-foreground">
                {headerCommitSha.slice(0, 7)}
              </span>
            )
          ) : null}
          <DropdownMenuContent align="start" className="w-49">
            <DropdownMenuRadioGroup value={selectedScopeValue} onValueChange={selectScopeValue}>
              <DropdownMenuRadioItem value="unstaged" closeOnClick>
                <span>Working tree</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="branch" closeOnClick>
                <span>Branch changes</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="latest" closeOnClick>
                <span>Latest turn</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
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
                          <span className="ml-auto text-meta tabular-nums text-muted-foreground">
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
                          "flex items-center rounded-item hover:surface-selected-soft has-data-highlighted:surface-selected-soft has-focus-visible:surface-selected-soft [&_[data-checked]]:bg-transparent [&_[data-highlighted]]:bg-transparent",
                          selectedCommitSha === commit.sha && "surface-selected-soft",
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
                              <span className="shrink-0 text-meta tabular-nums text-muted-foreground">
                                {formatRelativeTimeLabel(commit.committedAt, Date.parse(now))}
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
                            <span className="font-mono text-meta text-muted-foreground underline underline-offset-4">
                              {commit.sha.slice(0, 7)}
                            </span>
                          </DropdownMenuItem>
                        ) : (
                          <span className="shrink-0 px-2 font-mono text-meta text-muted-foreground">
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
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-meta text-muted-foreground"
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
                <span className="min-w-0 truncate font-normal">{comparisonBaseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
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
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border ps-3 pe-6.5 pt-2 pb-1.5 text-micro text-muted-foreground">
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
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <DiffViewControls
          diffLayout={diffLayout}
          wordWrap={wordWrap}
          onWordWrapChange={setWordWrap}
          ignoreWhitespace={diffIgnoreWhitespace}
          onIgnoreWhitespaceChange={setDiffIgnoreWhitespace}
          hasFiles={diffFileKeys.length > 0}
          testFileCount={testFileCount}
          hideTestFiles={hideTestFiles}
          onHideTestFilesChange={setHideTestFiles}
          fileTreeOpen={fileTreeOpen}
          onFileTreeOpenChange={setFileTreeOpen}
          allFilesCollapsed={allDiffFilesCollapsed}
          onToggleAllFiles={toggleDiffFileCollapse}
          refresh={
            canRefreshGitDiff
              ? { refreshing: isRefreshingDiff, onRefresh: refreshDiffFromUserAction }
              : undefined
          }
        />
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <PanelEmptyState
          icon={<FileDiffIcon />}
          title="No thread selected"
          description="Pick a thread to see what its turns changed."
        />
      ) : !isGitRepo && !toolCallSelection ? (
        <PanelEmptyState
          icon={<FolderGit2Icon />}
          title="Not a git repository"
          description="Diffs compare git checkpoints, so this project has none to show."
        />
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <PanelEmptyState
          icon={<HistoryIcon />}
          title="No turns yet"
          description="Each finished turn's changes land here."
        />
      ) : isGitSelection && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="Checking file access..." />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-meta text-dim-foreground">
            {fileAccess.error ?? "This connection cannot read local diffs."}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border surface-card px-3 py-1.5 text-caption text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
                {isGitSelection && selectedGitSource?.files ? " Totals include all changes." : ""}
              </p>
            )}
            {selectedPatchError && lazySource ? (
              <p className="shrink-0 px-3 text-caption text-error-foreground">
                {selectedPatchError}
              </p>
            ) : null}
            {omittedToolCallFiles > 0 && (
              <p className="shrink-0 border-b border-border surface-card px-3 py-1.5 text-caption text-muted-foreground">
                This tool call changed {recordedToolCallFileCount} files. The recorded patch omits{" "}
                {omittedToolCallFiles} of them.
              </p>
            )}
            {!renderablePatch && toolCallPreview && toolCallPreview.content.length > 0 ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-meta">
                {selectedPatchError ? (
                  <p className="text-error-foreground">{selectedPatchError}</p>
                ) : null}
                <p className="text-muted-foreground">
                  The provider recorded file content without a diff.
                </p>
                {toolCallPreview.content.map(({ label, text }) => (
                  <div key={label} className="space-y-1">
                    <p className="text-muted-foreground">{label}</p>
                    <pre
                      className={cn(
                        "overflow-auto font-mono text-meta",
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
              ) : selectedPatchError ? (
                <PanelEmptyState
                  tone="error"
                  icon={<TriangleAlertIcon />}
                  title="Couldn't load this diff"
                  description={selectedPatchError}
                  action={
                    !selectedTurn && canRefreshGitDiff ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => refreshDiffFromUserAction()}
                      >
                        Try again
                      </Button>
                    ) : null
                  }
                />
              ) : hasNoNetChanges ? (
                <PanelEmptyState
                  icon={<FileCheckIcon />}
                  title="No changes"
                  description={
                    selectedTurn
                      ? "This turn left every file as it was."
                      : selectedGitScope === "unstaged"
                        ? "The working tree matches the last commit."
                        : selectedGitScope === "commit"
                          ? "This commit has no changes."
                          : "This branch has no changes against its base."
                  }
                />
              ) : (
                <PanelEmptyState
                  icon={<FileDiffIcon />}
                  title="No patch available"
                  description="There is nothing to show for this selection."
                />
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
                    const filePath = diffHeaderTitlePath(composedPath);
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
                    const filePath = diffHeaderTitlePath(composedPath)?.trim();
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
                    onCommentAdded={addToReviewBatch}
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
                    renderHeaderMetadata={(fileDiff) => {
                      // A lazily loaded file's hunks may not be here yet; the scope's stats are.
                      const stat = lazySource
                        ? fileStats.get(resolveFileDiffPath(fileDiff))
                        : fileDiffLineStat(fileDiff);
                      return stat ? (
                        <DiffFileHeaderStat additions={stat.additions} deletions={stat.deletions} />
                      ) : null;
                    }}
                    onRevealSearchMatch={unfoldDiffFile}
                    renderHeaderPrefix={(fileDiff, fileKey) => {
                      const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
                      const filePath = resolveFileDiffPath(fileDiff);
                      // One flex row: the slot wraps it in a block div, and bare svgs would stack.
                      return (
                        <span className="flex min-w-0 items-center gap-1.25">
                          <DiffFileCollapseToggle
                            filePath={filePath}
                            fileKey={fileKey}
                            collapsed={unavailable || collapsedDiffFileKeys.has(fileKey)}
                            unavailable={unavailable}
                            iconClassName={getDiffCollapseIconClassName(fileDiff)}
                            onToggle={toggleDiffFileCollapsed}
                          />
                          <DiffFileChangeIcon type={fileDiff.type} />
                          <DiffFileBasename path={filePath} />
                        </span>
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
                  <p className="text-caption text-dim-foreground">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-control surface-well p-3 font-mono text-caption leading-relaxed text-muted-foreground",
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
            <DiffReviewTray
              composerDraftTarget={composerDraftTarget}
              commentIds={reviewBatchIds}
              onDismiss={dismissReviewBatch}
            />
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
