import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { useReviewDiffPreview } from "~/lib/reviewDiffPreviewState";
import { useVcsRefs } from "~/lib/vcsRefState";
import { useDiffRailState } from "~/lib/useDiffRailState";
import { useVcsStatus } from "~/lib/vcsStatusState";
import { readLocalApi } from "../localApi";
import { resolvePathLinkTarget } from "../terminal-links";
import {
  type DiffSourceParam,
  parseDiffRouteSearch,
  stripDiffSearchParams,
} from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { adaptFileDiffsToTreeChanges } from "../lib/diffFileTreeAdapter";
import { summarizeTurnDiffStats } from "../lib/turnDiffTree";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffPanelBody } from "./DiffPanelBody";
import {
  DiffPanelToolbar,
  type DiffBranchOption,
  type DiffRenderMode,
  type DiffSourceSelection,
} from "./DiffPanelToolbar";

type DiffThemeType = "light" | "dark";

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  // Default to wrapping in the panel: it is a narrow side surface, so wrapping
  // keeps long lines readable instead of overflowing horizontally. Users can
  // still toggle it off from the toolbar.
  const [diffWordWrap, setDiffWordWrap] = useState(true);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const { railSize, railCollapsed, setRailSize, toggleRailCollapsed, minRailSize, maxRailSize } =
    useDiffRailState();
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const previousDiffOpenRef = useRef(false);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeThread && activeProjectId
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        })
      : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useVcsStatus({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd ?? null,
  });
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
  const changedTurnDiffSummaries = useMemo(
    () => orderedTurnDiffSummaries.filter((summary) => summary.files.length > 0),
    [orderedTurnDiffSummaries],
  );
  // Map each turn to the user prompt that started it, for the Turns submenu.
  const turnPromptByTurnId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const message of activeThread?.messages ?? []) {
      if (message.role !== "user" || !message.turnId) continue;
      const text = message.text.trim();
      if (text.length > 0 && map[message.turnId] === undefined) {
        map[message.turnId] = text;
      }
    }
    return map;
  }, [activeThread?.messages]);
  const latestTurn = changedTurnDiffSummaries[0];
  const latestTurnId = latestTurn?.turnId ?? null;

  // Resolve the active diff source from the route. A specific `diffTurnId`
  // always wins (the "Turns" submenu selection); otherwise the `diffSource`
  // param is used, defaulting to the branch diff.
  const source = useMemo<DiffSourceSelection>(() => {
    if (diffSearch.diffTurnId) {
      return { kind: "turn", turnId: diffSearch.diffTurnId };
    }
    const param: DiffSourceParam = diffSearch.diffSource ?? "branch";
    switch (param) {
      case "working-tree":
        return { kind: "working-tree" };
      case "all-turns":
        return { kind: "all-turns" };
      case "last-turn":
        return { kind: "last-turn" };
      case "branch":
      default:
        return { kind: "branch", baseRef: diffSearch.diffBaseRef ?? null };
    }
  }, [diffSearch.diffBaseRef, diffSearch.diffSource, diffSearch.diffTurnId]);

  const selectedFilePath = diffSearch.diffFilePath ?? null;

  // Resolve which turn (if any) the checkpoint fetch should target.
  const checkpointTurn = useMemo(() => {
    if (source.kind === "turn") {
      return (
        changedTurnDiffSummaries.find((summary) => summary.turnId === source.turnId) ??
        changedTurnDiffSummaries[0]
      );
    }
    if (source.kind === "last-turn") {
      return latestTurn;
    }
    return undefined;
  }, [changedTurnDiffSummaries, latestTurn, source]);

  const selectedCheckpointTurnCount =
    checkpointTurn &&
    (checkpointTurn.checkpointTurnCount ??
      inferredCheckpointTurnCountByTurnId[checkpointTurn.turnId]);
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
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts: Array<number> = [];
    for (const summary of orderedTurnDiffSummaries) {
      const value =
        summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof value === "number") {
        turnCounts.push(value);
      }
    }
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      source.kind === "all-turns" && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, source.kind],
  );

  const usesCheckpoint =
    source.kind === "turn" || source.kind === "last-turn" || source.kind === "all-turns";
  const usesReview = source.kind === "branch" || source.kind === "working-tree";

  const activeCheckpointRange = checkpointTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (checkpointTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [checkpointTurn, orderedTurnDiffSummaries]);

  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: checkpointTurn ? `turn:${checkpointTurn.turnId}` : conversationCacheScope,
    },
    { enabled: isGitRepo && usesCheckpoint },
  );

  const selectedBaseRef = source.kind === "branch" ? source.baseRef : null;
  const reviewDiff = useReviewDiffPreview(
    {
      environmentId: activeThread?.environmentId ?? null,
      cwd: activeCwd ?? null,
      baseRef: selectedBaseRef,
    },
    { enabled: isGitRepo && usesReview },
  );
  const branchSource = useMemo(
    () => reviewDiff.data?.sources.find((entry) => entry.kind === "branch-range") ?? null,
    [reviewDiff.data],
  );
  const workingTreeSource = useMemo(
    () => reviewDiff.data?.sources.find((entry) => entry.kind === "working-tree") ?? null,
    [reviewDiff.data],
  );
  const branchBaseLabel = branchSource?.baseRef ?? null;
  const currentBranch = gitStatusQuery.data?.refName ?? activeThread?.branch ?? null;

  // Branches to compare against. Only fetch when the source dropdown could use
  // it (branch mode) so we don't list refs for turn/working-tree views.
  const vcsRefs = useVcsRefs({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd ?? null,
  });
  const branchOptions = useMemo<ReadonlyArray<DiffBranchOption>>(() => {
    const refs = vcsRefs.data?.refs ?? [];
    return refs.map((ref) => ({
      name: ref.name,
      current: ref.current,
      isDefault: ref.isDefault,
      isRemote: ref.isRemote ?? false,
    }));
  }, [vcsRefs.data]);

  // Resolve the active patch + loading/error state for whichever source is active.
  const selectedPatch = usesReview
    ? source.kind === "branch"
      ? branchSource?.diff
      : workingTreeSource?.diff
    : activeCheckpointDiff.data?.diff;
  const isLoadingDiff = usesReview ? reviewDiff.isPending : activeCheckpointDiff.isPending;
  const diffError = usesReview ? reviewDiff.error : activeCheckpointDiff.error;

  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
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

  const diffStats = useMemo(
    () => summarizeTurnDiffStats(adaptFileDiffsToTreeChanges(renderableFiles)),
    [renderableFiles],
  );

  const allFileKeys = useMemo(() => renderableFiles.map(buildFileDiffRenderKey), [renderableFiles]);
  const allCollapsed =
    allFileKeys.length > 0 && allFileKeys.every((fileKey) => collapsedDiffFileKeys.has(fileKey));

  const toggleCollapseAll = useCallback(() => {
    setCollapsedDiffFileKeys((current) => {
      const everyCollapsed =
        allFileKeys.length > 0 && allFileKeys.every((fileKey) => current.has(fileKey));
      return everyCollapsed ? new Set() : new Set(allFileKeys);
    });
  }, [allFileKeys]);

  const toggleFileCollapse = useCallback((fileKey: string) => {
    setCollapsedDiffFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (renderableFiles.length === 0) {
      setCollapsedDiffFileKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffIgnoreWhitespace]);

  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const selectSource = useCallback(
    (next: DiffSourceSelection) => {
      if (!activeThread) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          if (next.kind === "turn") {
            return { ...rest, diff: "1" as const, diffTurnId: next.turnId };
          }
          if (next.kind === "branch") {
            return {
              ...rest,
              diff: "1" as const,
              diffSource: "branch" as const,
              ...(next.baseRef ? { diffBaseRef: next.baseRef } : {}),
            };
          }
          return { ...rest, diff: "1" as const, diffSource: next.kind };
        },
      });
    },
    [activeThread, navigate],
  );
  const selectFile = useCallback(
    (filePath: string) => {
      if (!activeThread) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
        // Keep the current source params; only set the focused file.
        search: (previous) => ({ ...previous, diff: "1", diffFilePath: filePath }),
      });
    },
    [activeThread, navigate],
  );

  const refreshDiff = useCallback(() => {
    if (usesReview) {
      reviewDiff.refresh();
    }
  }, [reviewDiff, usesReview]);

  const headerRow = (
    <DiffPanelToolbar
      source={source}
      currentBranch={currentBranch}
      branchBaseLabel={branchBaseLabel}
      branches={branchOptions}
      changedTurnDiffSummaries={changedTurnDiffSummaries}
      turnPromptByTurnId={turnPromptByTurnId}
      latestTurnId={latestTurnId}
      inferredCheckpointTurnCountByTurnId={inferredCheckpointTurnCountByTurnId}
      formatTurnTimestamp={(completedAt) =>
        formatShortTimestamp(completedAt, settings.timestampFormat)
      }
      onSelectSource={selectSource}
      additions={diffStats.additions}
      deletions={diffStats.deletions}
      railCollapsed={railCollapsed}
      onToggleRail={toggleRailCollapsed}
      diffRenderMode={diffRenderMode}
      onDiffRenderModeChange={setDiffRenderMode}
      diffWordWrap={diffWordWrap}
      onDiffWordWrapChange={setDiffWordWrap}
      diffIgnoreWhitespace={diffIgnoreWhitespace}
      onDiffIgnoreWhitespaceChange={setDiffIgnoreWhitespace}
      allCollapsed={allCollapsed}
      onToggleCollapseAll={toggleCollapseAll}
      onRefresh={refreshDiff}
    />
  );

  const loadingLabel = usesReview ? "Loading diff..." : "Loading checkpoint diff...";

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Diffs are unavailable because this project is not a git repository.
        </div>
      ) : (
        <div className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {diffError && !renderablePatch && (
            <div className="px-3 pt-2">
              <p className="mb-2 text-[11px] text-red-500/80">{diffError}</p>
            </div>
          )}
          {!renderablePatch ? (
            isLoadingDiff ? (
              <DiffPanelLoadingState label={loadingLabel} />
            ) : (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                <p>
                  {hasNoNetChanges
                    ? "No changes in this selection."
                    : "No diff available for this selection."}
                </p>
              </div>
            )
          ) : (
            <DiffPanelBody
              renderablePatch={renderablePatch}
              selectedFilePath={selectedFilePath}
              diffRenderMode={diffRenderMode}
              diffWordWrap={diffWordWrap}
              collapsedFileKeys={collapsedDiffFileKeys}
              onToggleFileCollapse={toggleFileCollapse}
              resolvedTheme={resolvedTheme as DiffThemeType}
              railCollapsed={railCollapsed}
              railSize={railSize}
              onRailResize={setRailSize}
              railMinSize={minRailSize}
              railMaxSize={maxRailSize}
              onSelectFile={selectFile}
              onOpenFileInEditor={openDiffFileInEditor}
            />
          )}
        </div>
      )}
    </DiffPanelShell>
  );
}
