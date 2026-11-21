import { T, useGT, useMessages, Var } from "gt-react";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  CHECKPOINT_DIFF_TRUNCATED_MARKER,
  type ReviewBranchCommitsResult,
  type ScopedThreadRef,
  type RunId,
} from "@t3tools/contracts";
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
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import * as Schema from "effect/Schema";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useCodeViewScrollRestore } from "./diffs/useCodeViewScrollRestore";
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
  buildFileDiffEntries,
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
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { FileExplorerPane } from "./files/FileExplorerPane";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
import { getDiffHeaderClickAction } from "./diffs/diffHeaderClick";
import { Button } from "./ui/button";
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

import { observeIntersection } from "~/lib/observeIntersection";
import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
import { projectCommitUrl } from "@t3tools/client-runtime/change-request-links";
import { useOpenLink } from "../browser/useOpenLink";

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  onToggle,
  load,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  load?: () => void;
  onToggle: (fileKey: string) => void;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={
              collapsed
                ? gt("Expand {path}", { path: filePath })
                : gt("Collapse {path}", { path: filePath })
            }
            aria-expanded={!collapsed}
            ref={(node) => {
              if (!node || !load) return;
              return observeIntersection(
                node,
                (entry) => {
                  if (entry.isIntersecting) load();
                },
                { rootMargin: "600px" },
              );
            }}
            data-diff-file-key={fileKey}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        {collapsed ? (
          <ChevronRightIcon className="size-4 text-muted-foreground/80" />
        ) : (
          <ChevronDownIcon className="size-4 text-muted-foreground/80" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? gt("Expand diff") : gt("Collapse diff")}</TooltipPopup>
    </Tooltip>
  );
}

function DiffFileHeaderSuffix({
  filePath,
  workspaceRoot,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  workspaceRoot: string | undefined;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} workspaceRoot={workspaceRoot} />
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
  const gt = useGT();
  const messages = useMessages();
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    changesComparison: settings.changesComparison,
    timestampFormat: settings.timestampFormat,
    wordWrap: settings.wordWrap,
  }));
  const diffLayout = settings.diffLayout;
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? settings.wordWrap;
  const diffIgnoreWhitespace =
    useDiffPanelSessionStore((state) => state.ignoreWhitespace) ?? settings.diffIgnoreWhitespace;
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const [baseRefQuery, setBaseRefQuery] = useState("");
  // The open commit menu keeps the list it opened with, so rows do not move under the pointer.
  const [openCommitMenu, setOpenCommitMenu] = useState<ReviewBranchCommitsResult | null>(null);

  const routeThreadRef = useThreadRouteRef();
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null, messages);
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
  const activeRepositoryRoot =
    gitStatusQuery.data?.workingTree.rootPath ??
    (activeThread?.worktreePath ? undefined : activeProject?.repositoryIdentity?.rootPath);
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const rememberedBaseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, routeThreadRef),
  );
  const toolCallSelection = diffSelection.kind === "tool-call" ? diffSelection : null;
  // Turn and git diffs name files from the repository root; a tool call's diff names them as
  // its provider recorded them, absolute or relative to the workspace.
  const diffPathRepositoryRoot = toolCallSelection ? undefined : activeRepositoryRoot;
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
  const selectedFilePath = diffSelection.kind === "turn" ? (diffSelection.filePath ?? null) : null;
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
  const codeViewMountKey = collapseScopeKey ?? reviewSectionId;
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
          metadataOnly: true,
          ...(settings.changesComparison === "committed"
            ? { branchMode: "committed" as const }
            : {}),
          ...(selectedCommitSha === null
            ? {
                sourceKind:
                  selectedGitScope === "unstaged"
                    ? ("working-tree" as const)
                    : ("branch-range" as const),
              }
            : {}),
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
    messages,
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
    messages,
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
  // A committed comparison pins its head to a commit SHA, so name the branch instead.
  const comparisonHeadRef =
    (selectedGitSource?.branchMode === "committed" ? null : selectedGitSource?.headRef) ??
    gitStatusQuery.data?.refName ??
    "HEAD";
  const comparisonBaseRef =
    selectedGitSource?.baseRef ??
    selectedBaseRef ??
    gt("Automatic", { $context: "compare against the default base ref" });
  const selectedCommitSubject =
    selectedCommitSha !== null && selectedGitSource?.headRef === selectedCommitSha
      ? selectedGitSource.commitSubject
      : undefined;
  const selectedGitScopeLabel =
    selectedCommitSha !== null
      ? (selectedCommitSubject ?? gt("Commit {sha}", { sha: selectedCommitSha.slice(0, 7) }))
      : selectedGitScope === "unstaged"
        ? gt("Uncommitted")
        : gt("Changes");
  const selectedTurnLabel = gt("Turn {count}", { count: selectedCheckpointTurnCount ?? "?" });
  const selectedScopeLabel = toolCallSelection
    ? gt("Tool call")
    : selectedRunId === null
      ? selectedCommitSha !== null
        ? (selectedCommitSubject ?? gt("Commit", { $context: "a git commit" }))
        : selectedGitScopeLabel
      : selectedTurn?.runId === latestTurn?.runId
        ? gt("Latest turn")
        : selectedTurnLabel;
  const reviewSectionTitle = toolCallSelection
    ? gt("Tool call")
    : selectedTurn
      ? selectedTurnLabel
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
    toolCallSelection && toolCallItem?.type === "file_change"
      ? toolCallDiff(toolCallItem, activeCwd, messages)
      : null;
  const selectedPatch = toolCallSelection
    ? toolCallPreview?.patch
    : selectedTurn
      ? activeCheckpointDiff.data?.diff
      : gitDiff;
  const isSelectedPatchTruncated =
    toolCallPreview?.truncated === true ||
    (isGitSelection && selectedGitSource?.truncated === true) ||
    (!toolCallSelection &&
      selectedTurn !== undefined &&
      selectedPatch?.endsWith(CHECKPOINT_DIFF_TRUNCATED_MARKER) === true);
  const selectedPatchQuery = toolCallSelection
    ? toolCallDetail
    : selectedTurn
      ? activeCheckpointDiff
      : branchDiffPreview;
  const isLoadingSelectedPatch =
    selectedPatchQuery.isPending &&
    (selectedPatchQuery.data === null ||
      (isGitSelection && preview?.incomplete === true && selectedGitSource?.files?.length === 0));
  const selectedPatchError = toolCallSelection
    ? toolCallDetail.error
    : selectedTurn
      ? activeCheckpointDiff.error
      : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges =
    hasResolvedPatch &&
    selectedPatch.trim().length === 0 &&
    !preview?.incomplete &&
    (!selectedGitSource?.patchesDeferred || selectedGitSource.files?.length === 0);
  const lazySource =
    isGitSelection &&
    (selectedGitSource?.truncated || selectedGitSource?.patchesDeferred) &&
    selectedGitSource.files?.length
      ? selectedGitSource
      : null;
  const renderablePatch = getRenderablePatch(
    lazySource ? undefined : selectedPatch,
    `diff-panel:${resolvedTheme}`,
    {
      compactPartialHunkOffsets: isGitSelection,
      ...(toolCallSelection ? { ignoreWhitespace: diffIgnoreWhitespace } : {}),
    },
    messages,
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
          ...(selectedGitSource.branchMode ? { branchMode: selectedGitSource.branchMode } : {}),
          cacheKey: selectedGitSource.diffHash,
        })
      : undefined;
  const loadDiffFiles: FileDiffContentsLoader = useStableCallback(async (fileDiff) => {
    if (!currentLoadDiffFiles) {
      throw new Error(gt("Diff file contents are unavailable for this selection."));
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
    isPending: areFilePatchesPending,
    fileStates,
    retry,
    requestFile,
    renderableFiles,
    remainingFileCount,
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
  const pathOccurrences = new Map<string, number>();
  const renderableFileEntries = buildFileDiffEntries(renderableFiles).map((entry) => {
    if (!isGitSelection) return entry;
    const { fileDiff } = entry;
    // Metadata's change type can be missing or differ from the patch's; key each path's identity by path.
    const pathKey = JSON.stringify([fileDiff.prevName ?? fileDiff.name, fileDiff.name]);
    const occurrence = pathOccurrences.get(pathKey) ?? 0;
    pathOccurrences.set(pathKey, occurrence + 1);
    return { ...entry, fileKey: `${pathKey}:${occurrence}` };
  });
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
    remainingFileCount > 0 ? (
      <DiffFileLoadingBoundary load={loadNextFiles} count={remainingFileCount} />
    ) : null;
  const codeViewFiles = shownFileEntries.map(({ fileDiff, fileKey, fileVersion }) => ({
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
  // Lazy files that sat above the saved position load again only when asked for.
  const codeViewScroll = useCodeViewScrollRestore(
    collapseScopeKey,
    !isRefreshingDiff && remainingFileCount === 0,
    remainingFileCount > 0 ? loadNextFiles : null,
  );
  const attachCodeView = useStableCallback((handle: AnnotatableCodeViewHandle | null) => {
    codeViewScroll.attach(handle);
    codeViewReveal.attach(handle);
  });
  const flushCodeView = useStableCallback(() => {
    codeViewScroll.flush();
    codeViewReveal.flush();
  });
  const revealDiffFile = (filePath: string) => {
    const index = renderableFileEntries.findIndex(
      (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
    );
    const file = renderableFileEntries[index];
    if (!file) return false;
    codeViewScroll.discard();
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      next.delete(file.fileKey);
      return next;
    });
    if (lazySource) requestFile(filePath);
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
      repositoryRoot: diffPathRepositoryRoot,
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
    const file = renderableFileEntries.find((file) => file.fileKey === fileKey);
    if (lazySource && file) requestFile(resolveFileDiffPath(file.fileDiff));
    const pending = file?.fileDiff.cacheKey?.endsWith(":pending") === true;
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      if (pending || next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  });
  const setDiffFileCollapsed = useStableCallback((fileKey: string, collapsed: boolean) => {
    updateCollapsedDiffFiles((current) => {
      if (current.has(fileKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(fileKey);
      else next.delete(fileKey);
      return next;
    });
  });

  const toggleDiffFileCollapse = () => {
    codeViewScroll.discard();
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
            aria-label={gt("Diff scope: {scope}", { scope: selectedScopeLabel })}
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
                <span>
                  <T>Changes</T>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="unstaged" closeOnClick>
                <span>
                  <T>Uncommitted</T>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="latest" closeOnClick>
                <span>
                  <T>Latest turn</T>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <T context="agent turn">Turn</T>
              </DropdownMenuSubTrigger>
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
                          <span>
                            <T>
                              Turn <Var>{turnCount}</Var>
                            </T>
                          </span>
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
              <DropdownMenuSubTrigger>
                <T>Commits</T>
              </DropdownMenuSubTrigger>
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
                                {formatRelativeTimeLabel(commit.committedAt, undefined, messages)}
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
                                aria-label={gt("Open commit {sha}", {
                                  sha: commit.sha.slice(0, 7),
                                })}
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
                      ? gt("Checking file access...")
                      : (fileAccess.error ?? gt("This connection cannot read local diffs."))}
                  </DropdownMenuItem>
                ) : branchCommits === null ? (
                  <DropdownMenuItem disabled>
                    <T>Loading commits...</T>
                  </DropdownMenuItem>
                ) : branchCommits.commits.length === 0 ? (
                  <DropdownMenuItem disabled>
                    <T>No commits on this branch.</T>
                  </DropdownMenuItem>
                ) : branchCommits.truncated ? (
                  <DropdownMenuItem disabled>
                    {gt(
                      "{count, plural, one {Showing latest {count} commits} other {Showing latest {count} commits}}",
                      { count: branchCommits.commits.length },
                    )}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {canSelectBranchBase && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={gt("Comparing {head} against {base}", {
              head: comparisonHeadRef,
              base: comparisonBaseRef,
            })}
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
                <T>vs</T>
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
                aria-label={gt("Change comparison target. Currently {base}", {
                  base: comparisonBaseRef,
                })}
              >
                <span className="min-w-0 truncate">{comparisonBaseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
              >
                <ComboboxSearchInput
                  placeholder={gt("Search refs...")}
                  value={baseRefQuery}
                  onChange={(event) => setBaseRefQuery(event.target.value)}
                />
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>
                      <T context="git branch">Branch</T>
                    </span>
                    <span className="text-right">
                      <T context="git remote">Remote</T>
                    </span>
                  </div>
                </div>
                <ComboboxEmpty>
                  <T>No matching refs.</T>
                </ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)]"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">
                      <T context="compare against the default base ref">Automatic</T>
                    </span>
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
                                aria-label={gt("Use remote version of {ref}", {
                                  ref: choice.label,
                                })}
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
                                      aria-label={gt("Remote only")}
                                      className="size-3"
                                    />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">
                                <T>Remote only</T>
                              </TooltipPopup>
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
                  aria-label={isRefreshingDiff ? gt("Refreshing diff") : gt("Refresh diff")}
                  onClick={refreshDiffFromUserAction}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? gt("Refreshing diff…") : gt("Refresh diff")}
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
                  aria-label={
                    allDiffFilesCollapsed ? gt("Expand all files") : gt("Collapse all files")
                  }
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? gt("Expand all files") : gt("Collapse all files")}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label={gt("Diff layout")}
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
          <Toggle aria-label={gt("Stacked diff view")} value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label={gt("Split diff view")} value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  wordWrap ? gt("Disable diff line wrapping") : gt("Enable diff line wrapping")
                }
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrapOverride(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? gt("Disable line wrapping") : gt("Enable line wrapping")}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace
                    ? gt("Show whitespace changes")
                    : gt("Hide whitespace changes")
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  useDiffPanelSessionStore.getState().setIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? gt("Show whitespace changes") : gt("Hide whitespace changes")}
          </TooltipPopup>
        </Tooltip>
        {testFileCount > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={gt("Hide test files")}
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
                ? gt(
                    "{count, plural, one {Show {count} hidden test file} other {Show {count} hidden test files}}",
                    { count: testFileCount },
                  )
                : gt("Hide test files")}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? gt("Hide file tree") : gt("Show file tree")}
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
              {fileTreeOpen ? gt("Hide file tree") : gt("Show file tree")}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          <T>Select a thread to inspect turn diffs.</T>
        </div>
      ) : !isGitRepo && !toolCallSelection ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          <T>Turn diffs are unavailable because this project is not a git repository.</T>
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          <T>No completed turns yet.</T>
        </div>
      ) : isGitSelection && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label={gt("Checking file access...")} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {fileAccess.error ?? gt("This connection cannot read local diffs.")}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {preview?.incomplete && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                {selectedPatchError
                  ? gt(
                      "Showing tracked changes. Untracked changes could not be loaded. Refresh to retry.",
                    )
                  : gt("Showing tracked changes. Checking untracked files...")}
              </p>
            )}
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                {isGitSelection && selectedGitSource?.files && !preview?.incomplete
                  ? gt(
                      "This preview exceeds the size limit. Changes shown are incomplete. Totals include all changes.",
                    )
                  : gt("This preview exceeds the size limit. Changes shown are incomplete.")}
              </p>
            )}
            {omittedToolCallFiles > 0 && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                {gt(
                  "This tool call changed {recorded} files. The recorded patch omits {omitted} of them.",
                  {
                    recorded: recordedToolCallFileCount,
                    omitted: omittedToolCallFiles,
                  },
                )}
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
                  <T>The provider recorded file content without a diff.</T>
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
                      {text === "" ? gt("Empty content.") : text}
                    </pre>
                  </div>
                ))}
              </div>
            ) : !renderablePatch && !lazySource ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    toolCallSelection
                      ? gt("Loading tool call diff...")
                      : selectedTurn
                        ? gt("Loading checkpoint diff...")
                        : selectedGitScope === "unstaged"
                          ? gt("Loading uncommitted changes...")
                          : selectedGitScope === "commit"
                            ? gt("Loading commit...")
                            : gt("Loading changes...")
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? gt("No net changes in this selection.")
                      : gt("No patch available for this selection.")}
                  </p>
                </div>
              )
            ) : lazySource || renderablePatch?.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const action = getDiffHeaderClickAction(event.nativeEvent);
                    if (action?.type === "open") openDiffFile(action.filePath);
                    else if (action?.type === "toggle") toggleDiffFileCollapsed(action.fileKey);
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
                        repositoryRoot: diffPathRepositoryRoot,
                      },
                      event,
                    );
                  }}
                >
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    environmentId={activeThread?.environmentId}
                    projectId={activeThread?.projectId}
                    viewerRef={attachCodeView}
                    onScroll={codeViewScroll.onScroll}
                    codeViewKey={codeViewMountKey}
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
                          workspaceRoot={activeCwd}
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
                    onFileCollapsedChange={setDiffFileCollapsed}
                    renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                      return (
                        <DiffFileCollapseToggle
                          filePath={resolveFileDiffPath(fileDiff)}
                          fileKey={fileKey}
                          collapsed={collapsed}
                          onToggle={toggleDiffFileCollapsed}
                          {...(fileDiff.cacheKey?.endsWith(":pending") &&
                          !collapsedDiffFileKeys.has(fileKey)
                            ? {
                                load: () => requestFile(resolveFileDiffPath(fileDiff)),
                              }
                            : {})}
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
                      onPostRender: flushCodeView,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <FileExplorerPane
                    resizable
                    storageKey="t3code:diff-file-tree-width"
                    defaultWidthFraction={0.4}
                    resizeLabel={gt("Resize Changes files")}
                  >
                    <DiffFileTree
                      ariaLabel={gt("{section} files", { section: reviewSectionTitle })}
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
