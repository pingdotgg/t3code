import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderGit2Icon,
  PilcrowIcon,
  RefreshCwIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useProject, useThread } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

// Last path segment of a repo root, used to label repos and compare a project's
// configured roots against the single root the branch diff actually covers
// (paths differ between a thread worktree and the project checkout, but the repo
// folder name is stable across both).
function repoRootBaseName(rootPath: string): string {
  const trimmed = rootPath.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || trimmed;
}

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "unstaged";
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

// Diff queries are stale-while-revalidate atoms: a remount within their stale
// window serves the cached patch without refetching. The diff panel unmounts
// when you switch right-panel surfaces and remounts when you reopen it, so a
// reopened panel would otherwise show a stale diff. Force a refresh whenever the
// panel reopens — detected by cached data already being present on the first
// render — so opening the diff always reflects the current tree. A true first
// open (no cached data yet) is left to the atom's own initial fetch.
function useRefreshOnReopen(refresh: () => void, hasCachedData: boolean) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const reopenedRef = useRef(hasCachedData);
  useEffect(() => {
    if (reopenedRef.current) refreshRef.current();
  }, []);
}

// One repo's section of a multi-repo branch/working diff. Each section fetches
// its own repo's diff preview (a separate cwd = that repo's worktree path) so
// the parent can render every repo grouped without a server round-trip change.
// Rendered behind the React hooks rules by giving each repo its own component.
function BranchDiffRepoSection({
  environmentId,
  cwd,
  repoRoot,
  scope,
  ignoreWhitespace,
  resolvedTheme,
  renderFileDiffEntry,
}: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly cwd: string;
  readonly repoRoot: string;
  readonly scope: "branch" | "unstaged";
  readonly ignoreWhitespace: boolean;
  readonly resolvedTheme: string;
  readonly renderFileDiffEntry: (fileDiff: FileDiffMetadata, repoRoot?: string) => ReactNode;
}) {
  const preview = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: { cwd, ignoreWhitespace },
    }),
  );
  useRefreshOnReopen(preview.refresh, preview.data !== null);
  const source = preview.data?.sources.find(
    (entry) => entry.kind === (scope === "unstaged" ? "working-tree" : "branch-range"),
  );
  const files = useMemo(() => {
    const renderable = getRenderablePatch(source?.diff, `diff-panel:${repoRoot}:${resolvedTheme}`, {
      compactPartialHunkOffsets: true,
    });
    if (!renderable || renderable.kind !== "files") return [];
    return renderable.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [repoRoot, resolvedTheme, source?.diff]);
  const countLabel =
    preview.isPending && source === undefined
      ? "Loading…"
      : `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return (
    <div>
      <div
        className="diff-render-group-header sticky top-0 z-10 mt-2 mb-1 flex items-center gap-2 rounded-md bg-background/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur first:mt-0"
        title={cwd}
      >
        <span className="truncate text-foreground/90">{repoRootBaseName(repoRoot)}</span>
        <span className="text-muted-foreground/70">{countLabel}</span>
        {source?.truncated === true && <span className="text-amber-500/80">truncated</span>}
      </div>
      {preview.error && files.length === 0 ? (
        <p className="px-2 pb-2 text-[11px] text-red-500/80">{preview.error}</p>
      ) : (
        files.map((fileDiff) => renderFileDiffEntry(fileDiff, repoRoot))
      )}
    </div>
  );
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const diffRenderMode = useDiffPanelStore((state) => state.diffRenderMode);
  const setDiffRenderMode = useDiffPanelStore((state) => state.setDiffRenderMode);
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [baseRefQuery, setBaseRefQuery] = useState("");
  // Repo filter for multi-repo workspaces, keyed by repo folder name (stable
  // across the worktree-path branch view and checkpoint-group turn view). null
  // shows every repo.
  const [branchRepoFilter, setBranchRepoFilter] = useState<string | null>(null);
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const [codeViewRevision, setCodeViewRevision] = useState(0);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const lastCompletedTurnRefreshRef = useRef<{
    readonly threadKey: string | null;
    readonly turnId: TurnId | null;
  } | null>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThread(routeThreadRef);
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
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      routeThreadRef,
      initialGitScope === "unstaged",
    ),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedTurnId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedTurnId === null
      ? selectedGitScope === "unstaged"
        ? "Working tree"
        : "Branch changes"
      : selectedTurn?.turnId === latestTurn?.turnId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : EMPTY_COLLAPSED_DIFF_FILE_KEYS;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "unstaged"
      ? "Working tree"
      : "Branch changes";
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedTurnId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedTurnId === null &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const branchDiffPreview = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview;
  const refreshBranchDiffPreview = branchDiffPreview.refresh;
  const canRefreshGitDiff =
    isGitRepo && selectedTurnId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useEffect(() => {
    const current = {
      threadKey: activeThreadRefreshKey,
      turnId: latestTurn?.turnId ?? null,
    };
    const previous = lastCompletedTurnRefreshRef.current;
    if (!canRefreshGitDiff) {
      return;
    }
    if (previous === null || previous.threadKey !== current.threadKey) {
      lastCompletedTurnRefreshRef.current = current;
      return;
    }
    if (previous.turnId === current.turnId) return;
    refreshBranchDiffPreview();
    lastCompletedTurnRefreshRef.current = current;
  }, [activeThreadRefreshKey, canRefreshGitDiff, latestTurn?.turnId, refreshBranchDiffPreview]);

  // Refresh the active diff sources when the panel reopens so a stale cached
  // patch never lingers (see useRefreshOnReopen). Covers the single-repo branch/
  // working diff, the checkpoint/turn diff, and the git status banner; multi-repo
  // branch sections refresh themselves in BranchDiffRepoSection.
  useRefreshOnReopen(branchDiffPreview.refresh, branchDiffPreview.data !== null);
  useRefreshOnReopen(activeCheckpointDiff.refresh, activeCheckpointDiff.data !== null);
  useRefreshOnReopen(gitStatusQuery.refresh, gitStatusQuery.data !== null);

  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === (selectedGitScope === "unstaged" ? "working-tree" : "branch-range"),
  );

  // Multi-repo workspaces run each repo in its own worktree under the thread's
  // worktree container; `worktrees` maps each repo root to its worktree path.
  // The single-cwd branch/working diff would only show one repo, so for these
  // threads we fan a diff-preview out per repo (see BranchDiffRepoSection) and
  // render every repo grouped, with a repo filter in the header.
  const threadWorktrees = useMemo(
    () => (activeThread?.worktrees ?? []).filter((entry) => entry.worktreePath.length > 0),
    [activeThread?.worktrees],
  );
  // The repo roots the branch/working diff fans out over, each paired with the
  // cwd to diff it in. Isolated runs create one worktree per repo, so diff those.
  // A non-isolated multi-repo `.code-workspace` has no worktrees and a container
  // `workspaceRoot` that isn't itself a git repo — so diff each repo root
  // directly (mirrors ChatView's per-repo git status). Without this the
  // single-cwd diff below runs `git diff` in the container and reports "no
  // changes" even when the repos have changes.
  const diffRepoTargets = useMemo(() => {
    if (threadWorktrees.length > 0) {
      return threadWorktrees.map((entry) => ({
        repoRoot: entry.repoRoot,
        cwd: entry.worktreePath,
      }));
    }
    const repoRoots = activeProject?.repoRoots ?? [];
    if (repoRoots.length > 1) {
      return repoRoots.map((repoRoot) => ({ repoRoot, cwd: repoRoot }));
    }
    return [];
  }, [threadWorktrees, activeProject?.repoRoots]);
  const isMultiRepoBranchView = selectedTurnId === null && diffRepoTargets.length > 1;
  // The diff reflects the thread's isolated worktree, not the user's own
  // checkout of the same repo. Showing the worktree path explains why on-disk
  // edits made elsewhere (e.g. a separate VS Code window) won't appear here.
  const diffWorktreePath = activeThread?.worktreePath ?? null;

  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (selectedTurnId !== null || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: selectedGitSource.diffHash,
    });
  }, [
    activeThread,
    branchDiffPreview.data,
    getDiffFileContents,
    selectedGitSource,
    selectedTurnId,
  ]);
  const localBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== selectedGitSource?.headRef) ?? [],
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
  const gitDiff = selectedGitSource?.diff;

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selectedTurnId === null,
      }),
    [resolvedTheme, selectedPatch, selectedTurnId],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const renderableFileEntries = useMemo(
    () =>
      renderableFiles.map((fileDiff) => ({
        fileDiff,
        fileKey: buildFileDiffRenderKey(fileDiff),
      })),
    [renderableFiles],
  );
  const codeViewFiles = useMemo(
    () =>
      renderableFileEntries.map(({ fileDiff, fileKey }) => {
        return {
          fileDiff,
          filePath: resolveFileDiffPath(fileDiff),
          fileKey,
          collapsed: collapsedDiffFileKeys.has(fileKey),
        };
      }),
    [collapsedDiffFileKeys, renderableFileEntries],
  );
  const diffFileKeys = useMemo(() => codeViewFiles.map((file) => file.fileKey), [codeViewFiles]);
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(() => getDiffLineStat(renderableFiles), [renderableFiles]);
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;

  // Multi-repo diffs arrive grouped per repo root. Parse each root's patch
  // separately so we can render a section header per repo and resolve open-file
  // against the right root. Single-root threads keep the flat rendering below.
  const activeDiffGroups = activeCheckpointDiff.data?.groups;
  const renderableGroups = useMemo(() => {
    if (!activeDiffGroups || activeDiffGroups.length === 0) {
      return [];
    }
    return activeDiffGroups
      .map((group) => {
        const renderable = getRenderablePatch(
          group.diff,
          `diff-panel:${group.repoRoot}:${resolvedTheme}`,
        );
        const files =
          renderable?.kind === "files"
            ? renderable.files.toSorted((left, right) =>
                resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
              )
            : [];
        return { repoRoot: group.repoRoot, displayName: group.displayName, files };
      })
      .filter((group) => group.files.length > 0);
  }, [activeDiffGroups, resolvedTheme]);
  const isGroupedDiffView = renderableGroups.length > 1;

  // Repo filter options come from whichever multi-repo view is active: the
  // per-worktree branch fan-out, or the checkpoint groups in a turn diff. Keyed
  // by folder name so a selection survives switching between the two.
  const repoFilterNames = useMemo(() => {
    const names = isMultiRepoBranchView
      ? diffRepoTargets.map((entry) => repoRootBaseName(entry.repoRoot))
      : renderableGroups.map((group) => repoRootBaseName(group.repoRoot));
    return Array.from(new Set(names));
  }, [isMultiRepoBranchView, renderableGroups, diffRepoTargets]);
  const showRepoFilter = repoFilterNames.length > 1;
  const effectiveRepoFilter =
    branchRepoFilter && repoFilterNames.includes(branchRepoFilter) ? branchRepoFilter : null;
  const visibleDiffTargets = effectiveRepoFilter
    ? diffRepoTargets.filter((entry) => repoRootBaseName(entry.repoRoot) === effectiveRepoFilter)
    : diffRepoTargets;
  const visibleGroups = effectiveRepoFilter
    ? renderableGroups.filter((group) => repoRootBaseName(group.repoRoot) === effectiveRepoFilter)
    : renderableGroups;

  useEffect(() => {
    if (!selectedDiffFileKey) return;
    codeViewRef.current?.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);

  const openDiffFile = useCallback(
    (filePath: string, repoRoot?: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        // In a multi-repo diff each file belongs to a specific repo root; resolve
        // open-file against it so the path isn't mistakenly joined to the anchor.
        activeCwd: repoRoot ?? activeCwd,
        repoRoot,
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
    },
    [activeCwd, openInPreferredEditor, routeThreadRef],
  );
  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFiles((current) => {
        const next = new Set(current.scopeKey === collapseScopeKey ? current.fileKeys : []);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [collapseScopeKey],
  );

  const toggleDiffFileCollapse = useCallback(() => {
    setCodeViewRevision((current) => current + 1);
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : EMPTY_COLLAPSED_DIFF_FILE_KEYS;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, diffFileKeys]);

  // Renders a single file's diff card. `repoRoot` is set in grouped (multi-repo)
  // mode so open-file resolves against that repo and the React key stays unique
  // when two repos share a relative path.
  const renderFileDiffEntry = (fileDiff: FileDiffMetadata, repoRoot?: string) => {
    const filePath = resolveFileDiffPath(fileDiff);
    const fileKey = buildFileDiffRenderKey(fileDiff);
    const themedFileKey = `${repoRoot ?? ""}:${fileKey}:${resolvedTheme}`;
    const collapsed = collapsedDiffFileKeys.has(fileKey);
    return (
      <div
        key={themedFileKey}
        data-diff-file-path={filePath}
        className="diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0"
        onClickCapture={(event) => {
          const nativeEvent = event.nativeEvent as MouseEvent;
          const composedPath = nativeEvent.composedPath?.() ?? [];
          const clickedHeader = composedPath.some((node) => {
            if (!(node instanceof Element)) return false;
            return node.hasAttribute("data-title");
          });
          if (!clickedHeader) return;
          openDiffFile(filePath, repoRoot);
        }}
      >
        <FileDiff
          fileDiff={fileDiff}
          renderHeaderPrefix={() => (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(
                      "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                      getDiffCollapseIconClassName(fileDiff),
                    )}
                    aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                    aria-expanded={!collapsed}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleDiffFileCollapsed(fileKey);
                    }}
                  />
                }
              >
                {collapsed ? (
                  <ChevronRightIcon className="size-4" />
                ) : (
                  <ChevronDownIcon className="size-4" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
            </Tooltip>
          )}
          options={{
            collapsed,
            diffStyle: diffRenderMode === "split" ? "split" : "unified",
            lineDiffType: "none",
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme as DiffThemeType,
            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
          }}
        />
      </div>
    );
  };

  const selectTurn = (turnId: TurnId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === "unstaged"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("unstaged")}
            >
              <span>Working tree</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === "branch"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("branch")}
            >
              <span>Branch changes</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId !== null && selectedTurn?.turnId === latestTurn?.turnId
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => {
                if (latestTurn) selectTurn(latestTurn.turnId);
              }}
            >
              <span>Latest turn</span>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {orderedTurnDiffSummaries.map((summary) => {
                  const turnCount =
                    summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                    "?";
                  return (
                    <DropdownMenuItem
                      key={summary.turnId}
                      className={
                        summary.turnId === selectedTurn?.turnId ? "bg-foreground/[0.08]" : undefined
                      }
                      onClick={() => selectTurn(summary.turnId)}
                    >
                      <span>Turn {turnCount}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {showRepoFilter ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Filter diff by repo. Currently ${effectiveRepoFilter ?? "all repos"}`}
            >
              <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
              <span className="max-w-32 truncate">{effectiveRepoFilter ?? "All repos"}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onClick={() => setBranchRepoFilter(null)}>
                <span>All repos</span>
                {effectiveRepoFilter === null && <CheckIcon className="ml-auto" />}
              </DropdownMenuItem>
              {repoFilterNames.map((name) => (
                <DropdownMenuItem key={name} onClick={() => setBranchRepoFilter(name)}>
                  <span className="truncate">{name}</span>
                  {effectiveRepoFilter === name && <CheckIcon className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          diffWorktreePath && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground"
                    aria-label={`Diff reflects the thread worktree at ${diffWorktreePath}`}
                  >
                    <FolderGit2Icon className="size-3.5 shrink-0 opacity-70" />
                    <span className="max-w-32 truncate">{repoRootBaseName(diffWorktreePath)}</span>
                  </span>
                }
              />
              <TooltipPopup side="bottom" className="max-w-80 whitespace-normal leading-tight">
                Reflects this thread&apos;s isolated worktree, not your own checkout of the repo:
                <br />
                <span className="font-mono break-all">{diffWorktreePath}</span>
              </TooltipPopup>
            </Tooltip>
          )
        )}
        {selectedTurnId === null &&
          selectedGitScope === "branch" &&
          !isMultiRepoBranchView &&
          selectedGitSource?.baseRef && (
            <div
              className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
              title={`${selectedGitSource.headRef ?? "HEAD"} → ${selectedGitSource.baseRef}`}
              aria-label={`Comparing ${selectedGitSource.headRef ?? "HEAD"} against ${selectedGitSource.baseRef}`}
            >
              <span className="min-w-0 max-w-48 truncate">
                {selectedGitSource.headRef ?? "HEAD"}
              </span>
              <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
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
                  className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
                >
                  <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                  <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
                </ComboboxTrigger>
                <ComboboxPopup
                  align="start"
                  className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
                >
                  <div className="min-w-0 shrink-0 px-3 pt-2.5">
                    <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                      <SearchIcon
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                      />
                      <ComboboxInput
                        className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                        inputClassName="rounded-none bg-transparent text-sm"
                        placeholder="Search refs..."
                        showTrigger={false}
                        size="sm"
                        unstyled
                        value={baseRefQuery}
                        onChange={(event) => setBaseRefQuery(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                    <span aria-hidden="true" />
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                      <span>Branch</span>
                      <span className="text-right">Remote</span>
                    </div>
                  </div>
                  <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                  <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                    <ComboboxItem
                      className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                      contentClassName="w-full min-w-0 overflow-hidden"
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
                          className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                          contentClassName="w-full min-w-0 overflow-hidden"
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
                              <span
                                className="flex justify-end text-muted-foreground"
                                title="Remote only"
                              >
                                <CheckIcon aria-hidden="true" className="size-3" />
                              </span>
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
        {codeViewFiles.length > 0 && (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-[11px]"
            layout="inline"
          />
        )}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={branchDiffPreview.isPending ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshBranchDiffPreview}
                />
              }
            >
              <RefreshCwIcon
                className={cn("size-3.5", branchDiffPreview.isPending && "animate-spin")}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {branchDiffPreview.isPending ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {codeViewFiles.length > 0 && (
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
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          className="shrink-0 gap-1"
          size="sm"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked" variant="ghost">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split" variant="ghost">
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
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedTurnId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!isMultiRepoBranchView && isSelectedPatchTruncated && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                This diff was truncated because it exceeded the preview limit. The changes shown are
                incomplete.
              </p>
            )}
            {!isMultiRepoBranchView && selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {isMultiRepoBranchView ? (
              <div className="diff-render-surface min-h-0 flex-1 overflow-auto">
                {visibleDiffTargets.map((entry) => (
                  <BranchDiffRepoSection
                    key={entry.repoRoot}
                    environmentId={activeThread.environmentId}
                    cwd={entry.cwd}
                    repoRoot={entry.repoRoot}
                    scope={selectedGitScope}
                    ignoreWhitespace={diffIgnoreWhitespace}
                    resolvedTheme={resolvedTheme}
                    renderFileDiffEntry={renderFileDiffEntry}
                  />
                ))}
              </div>
            ) : !renderablePatch ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedTurn
                      ? "Loading checkpoint diff..."
                      : selectedGitScope === "unstaged"
                        ? "Loading working tree diff..."
                        : "Loading branch diff..."
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
            ) : renderablePatch.kind === "files" ? (
              <div
                className="min-h-0 flex-1"
                onClickCapture={(event) => {
                  const composedPath = event.nativeEvent.composedPath?.() ?? [];
                  for (const node of composedPath) {
                    if (!(node instanceof HTMLElement)) continue;
                    // Header controls keep their own actions. In particular, the chevron must
                    // not also trigger the row handler or the two toggles cancel each other.
                    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                      return;
                    }
                  }
                  const title = composedPath.find(
                    (node): node is HTMLElement =>
                      node instanceof HTMLElement && node.hasAttribute("data-title"),
                  );
                  const filePath = title?.textContent?.trim();
                  // The filename remains the explicit "open in editor" affordance.
                  if (filePath) {
                    openDiffFile(filePath);
                    return;
                  }
                  const header = composedPath.find(
                    (node): node is HTMLElement =>
                      node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                  );
                  const headerFilePath = header?.querySelector("[data-title]")?.textContent?.trim();
                  if (!headerFilePath) return;
                  const file = codeViewFiles.find(
                    (candidate) => candidate.filePath === headerFilePath,
                  );
                  if (file) toggleDiffFileCollapsed(file.fileKey);
                }}
              >
                {isGroupedDiffView ? (
                  <Virtualizer
                    className="diff-render-surface h-full min-h-0 overflow-auto"
                    config={{
                      overscrollSize: 600,
                      intersectionObserverMargin: 1200,
                    }}
                  >
                    {visibleGroups.flatMap((group) => [
                      <div
                        key={`diff-group:${group.repoRoot}`}
                        className="diff-render-group-header sticky top-0 z-10 mt-2 mb-1 flex items-center gap-2 rounded-md bg-background/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur first:mt-0"
                        title={group.repoRoot}
                      >
                        <span className="truncate text-foreground/90">{group.displayName}</span>
                        <span className="text-muted-foreground/70">
                          {group.files.length} {group.files.length === 1 ? "file" : "files"}
                        </span>
                      </div>,
                      ...group.files.map((fileDiff) =>
                        renderFileDiffEntry(fileDiff, group.repoRoot),
                      ),
                    ])}
                  </Virtualizer>
                ) : (
                  <AnnotatableCodeView
                  key={collapseScopeKey ?? reviewSectionId}
                  viewerRef={codeViewRef}
                  codeViewKey={codeViewMountKey}
                  className="h-full min-h-0 overflow-auto"
                  files={codeViewFiles}
                  sectionId={reviewSectionId}
                  sectionTitle={reviewSectionTitle}
                  composerDraftTarget={composerDraftTarget}
                  renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    return (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className={cn(
                                "-ms-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                getDiffCollapseIconClassName(fileDiff),
                              )}
                              aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                              aria-expanded={!collapsed}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleDiffFileCollapsed(fileKey);
                              }}
                            />
                          }
                        >
                          {collapsed ? (
                            <ChevronRightIcon className="size-4" />
                          ) : (
                            <ChevronDownIcon className="size-4" />
                          )}
                        </TooltipTrigger>
                        <TooltipPopup side="top">
                          {collapsed ? "Expand diff" : "Collapse diff"}
                        </TooltipPopup>
                      </Tooltip>
                    );
                  }}
                  options={{
                    diffStyle: diffRenderMode === "split" ? "split" : "unified",
                    lineDiffType: "none",
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme as DiffThemeType,
                    stickyHeaders: true,
                    ...(loadDiffFiles ? { loadDiffFiles } : {}),
                  }}
                  />
                )}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
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
