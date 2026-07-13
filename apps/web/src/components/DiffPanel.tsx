import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { DiffFile, DiffSnapshot, TurnDiffScope, TurnId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  MinusIcon,
  PlusIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { useGitStatus } from "~/lib/gitStatusState";
import { diffStateQueryOptions, providerQueryKeys } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffScopeToggle } from "./chat/DiffScopeToggle";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const DIFF_ZOOM_MIN = 50;
const DIFF_ZOOM_MAX = 200;
const DIFF_ZOOM_STEP = 10;
const DIFF_ZOOM_DEFAULT = 100;

function diffZoomFontSizePx(zoom: number, basePx: number): number {
  return Math.round((basePx * zoom) / 100);
}

function diffZoomLineHeight(zoom: number): number {
  // Slightly tighter at small sizes, looser at large
  return zoom <= 75 ? 1.4 : zoom <= 100 ? 1.55 : 1.6;
}

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

function buildDiffPanelUnsafeCss(zoom: number, basePx: number): string {
  const fontSizePx = diffZoomFontSizePx(zoom, basePx);
  const lineHeight = diffZoomLineHeight(zoom);
  return `${DIFF_PANEL_UNSAFE_CSS}

[data-diff],
[data-file],
[data-file-info],
[data-file-info] *,
[data-diffs-header],
[data-diffs-header] *,
[data-line],
[data-code],
[data-code] *,
[data-line] *,
[data-diff] pre,
[data-diff] code,
[data-diff] table,
[data-diff] td {
  font-size: ${fontSizePx}px !important;
  line-height: ${lineHeight} !important;
}

[data-diffs-header] svg,
[data-file-info] svg,
[data-change-icon],
[data-rename-icon] {
  width: 1em !important;
  height: 1em !important;
}
`;
}

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

function diffFileSafetyLabel(diffFile: DiffFile | undefined): string | null {
  if (!diffFile) {
    return null;
  }
  if (diffFile.isBinary) {
    return "Binary file diff is not rendered.";
  }
  if (diffFile.hasHiddenBidiChars) {
    return "Hidden bidirectional Unicode characters detected.";
  }
  if (diffFile.size === "large") {
    return "Large diff collapsed by default.";
  }
  if (diffFile.size === "unrenderable") {
    return "Diff is too large to render safely.";
  }
  return null;
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffZoom, setDiffZoom] = useState(DIFF_ZOOM_DEFAULT);
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
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
  const gitStatusQuery = useGitStatus({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd ?? null,
  });
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const gitStatusRevision = useMemo(() => {
    const status = gitStatusQuery.data;
    if (!status) {
      return null;
    }
    return JSON.stringify({
      branch: status.branch,
      hasWorkingTreeChanges: status.hasWorkingTreeChanges,
      aheadCount: status.aheadCount,
      behindCount: status.behindCount,
      workingTreeFiles: status.workingTree.files.map((file) => [
        file.path,
        file.insertions,
        file.deletions,
      ]),
    });
  }, [gitStatusQuery.data]);
  const previousGitStatusRevisionRef = useRef<string | null>(null);
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

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFilePath = selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  // Exact match only. If diffTurnId points at a turn that has no summary
  // (deleted, never persisted, stale URL after revert), surface an explicit
  // unavailable state below — do NOT silently render some other turn's diff.
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId);
  const selectedTurnRequestedButMissing = selectedTurnId !== null && selectedTurn === undefined;
  // Server-bound queries require an actual persisted checkpointTurnCount. The
  // client-inferred count (from summary order) is not safe for diff requests:
  // missing checkpoints, reverts, or partial projection state can shift the
  // inferred index off the real checkpoint and produce a valid-looking diff
  // for the wrong turn.
  const selectedCheckpointTurnCount = selectedTurn?.checkpointTurnCount;
  const selectedTurnRangeMissing =
    selectedTurn !== undefined && typeof selectedCheckpointTurnCount !== "number";
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
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const selectedScope = selectedTurn ? (diffSearch.diffScope ?? "snapshot") : "snapshot";
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeDiffCacheScope = selectedTurn
    ? `turn:${selectedTurn.turnId}:${selectedScope}`
    : conversationCacheScope;
  const activeDiffStateQuery = useQuery(
    diffStateQueryOptions({
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      kind: selectedTurn ? "turn" : "conversation",
      scope: selectedScope,
      cacheScope: activeDiffCacheScope,
      enabled: isGitRepo && !selectedTurnRequestedButMissing && !selectedTurnRangeMissing,
    }),
  );
  useEffect(() => {
    if (!diffOpen || !activeThread || !gitStatusRevision) {
      return;
    }
    const previous = previousGitStatusRevisionRef.current;
    previousGitStatusRevisionRef.current = gitStatusRevision;
    if (previous === null || previous === gitStatusRevision) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: providerQueryKeys
        .diffState({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          fromTurnCount: null,
          toTurnCount: null,
        })
        .slice(0, 4),
    });
  }, [activeThread, diffOpen, gitStatusRevision, queryClient]);
  const activeDiffState = activeDiffStateQuery.data;
  const lastReadyDiffSnapshotByKeyRef = useRef(new Map<string, DiffSnapshot>());
  const activeDiffKey =
    activeThreadId && activeDiffCacheScope
      ? `${activeThread?.environmentId ?? "unknown"}:${activeThreadId}:${activeDiffCacheScope}:${activeCheckpointRange?.fromTurnCount ?? "none"}:${activeCheckpointRange?.toTurnCount ?? "none"}`
      : null;
  useEffect(() => {
    if (activeDiffKey && activeDiffState?._tag === "ready") {
      const snapshots = lastReadyDiffSnapshotByKeyRef.current;
      snapshots.set(activeDiffKey, activeDiffState.snapshot);
      if (snapshots.size > 20) {
        const oldestKey = snapshots.keys().next().value;
        if (oldestKey) {
          snapshots.delete(oldestKey);
        }
      }
    }
  }, [activeDiffKey, activeDiffState]);
  const staleSnapshot = activeDiffKey
    ? lastReadyDiffSnapshotByKeyRef.current.get(activeDiffKey)
    : undefined;
  const staleDiffState =
    staleSnapshot && (activeDiffState?._tag === "unavailable" || activeDiffState?._tag === "error")
      ? {
          _tag: "stale" as const,
          snapshot: staleSnapshot,
          message: activeDiffState.message,
        }
      : null;
  const displayDiffState = staleDiffState ?? activeDiffState;
  const activeDiffSnapshot =
    displayDiffState?._tag === "ready" || displayDiffState?._tag === "stale"
      ? displayDiffState.snapshot
      : null;
  const selectedTurnCheckpointDiff = selectedTurn ? activeDiffSnapshot?.patch : undefined;
  const conversationCheckpointDiff = selectedTurn ? undefined : activeDiffSnapshot?.patch;
  const isLoadingCheckpointDiff =
    activeDiffStateQuery.isLoading || displayDiffState?._tag === "loading";
  const diffStateMessage =
    displayDiffState?._tag === "unavailable" ||
    displayDiffState?._tag === "error" ||
    displayDiffState?._tag === "stale"
      ? displayDiffState.message
      : null;
  const checkpointDiffError =
    diffStateMessage ??
    (activeDiffStateQuery.error instanceof Error
      ? activeDiffStateQuery.error.message
      : activeDiffStateQuery.error
        ? "Failed to load checkpoint diff."
        : null);

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const diffSafetyByPath = useMemo(() => {
    const entries = activeDiffSnapshot?.files.map((file) => [file.path, file] as const) ?? [];
    return new Map(entries);
  }, [activeDiffSnapshot?.files]);
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
  const diffUnsafeCss = useMemo(
    () => buildDiffPanelUnsafeCss(diffZoom, settings.codeFontSize),
    [diffZoom, settings.codeFontSize],
  );
  const diffRawTextStyle = useMemo(
    () => ({
      fontSize: `${diffZoomFontSizePx(diffZoom, settings.codeFontSize)}px`,
      lineHeight: diffZoomLineHeight(diffZoom),
    }),
    [diffZoom, settings.codeFontSize],
  );

  useEffect(() => {
    if (renderableFiles.length === 0) {
      setCollapsedDiffFileKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      for (const fileDiff of renderableFiles) {
        const filePath = resolveFileDiffPath(fileDiff);
        const safety = diffSafetyByPath.get(filePath);
        if (safety?.size === "large") {
          next.add(buildFileDiffRenderKey(fileDiff));
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [diffSafetyByPath, renderableFiles]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

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
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
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

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const setSelectedScope = (scope: TurnDiffScope) => {
    if (!activeThread || !selectedTurnId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        diff: "1",
        diffTurnId: selectedTurnId,
        ...(diffSearch.diffFilePath ? { diffFilePath: diffSearch.diffFilePath } : {}),
        diffScope: scope,
      }),
    });
  };
  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setCanScrollTurnStripLeft(false);
      setCanScrollTurnStripRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setCanScrollTurnStripLeft(element.scrollLeft > 4);
    setCanScrollTurnStripRight(element.scrollLeft < maxScrollLeft - 4);
  }, []);
  const scrollTurnStripBy = useCallback((offset: number) => {
    const element = turnStripRef.current;
    if (!element) return;
    element.scrollBy({ left: offset, behavior: "smooth" });
  }, []);
  const onTurnStripWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = turnStripRef.current;
    if (!element) return;
    if (element.scrollWidth <= element.clientWidth + 1) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    event.preventDefault();
    element.scrollBy({ left: event.deltaY, behavior: "auto" });
  }, []);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    const onScroll = () => updateTurnStripScrollState();

    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      window.cancelAnimationFrame(frameId);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const headerRow = (
    <>
      <div className="relative min-w-0 flex-1 text-[length:var(--app-code-font-size)] [-webkit-app-region:no-drag]">
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-[1em]" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-[1em]" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
          style={
            canScrollTurnStripLeft || canScrollTurnStripRight
              ? {
                  maskImage: `linear-gradient(to right, ${canScrollTurnStripLeft ? "transparent 24px, black 72px" : "black"}, ${canScrollTurnStripRight ? "black calc(100% - 72px), transparent calc(100% - 24px)" : "black"})`,
                }
              : undefined
          }
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 text-[length:var(--app-code-font-size)] [-webkit-app-region:no-drag]">
        {selectedTurn && (
          <DiffScopeToggle value={selectedScope} onChange={setSelectedScope} className="shrink-0" />
        )}
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-[1em]" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-[1em]" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            setDiffWordWrap(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-[1em]" />
        </Toggle>
        <div className="flex shrink-0 items-center rounded-md border border-border/70">
          <button
            type="button"
            aria-label="Zoom out diff"
            title="Zoom out"
            disabled={diffZoom <= DIFF_ZOOM_MIN}
            onClick={() => setDiffZoom((z) => Math.max(DIFF_ZOOM_MIN, z - DIFF_ZOOM_STEP))}
            className="flex size-6 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MinusIcon className="size-[1em]" />
          </button>
          <span className="min-w-[2.6rem] select-none text-center font-medium tabular-nums text-muted-foreground">
            {diffZoom}%
          </span>
          <button
            type="button"
            aria-label="Zoom in diff"
            title="Zoom in"
            disabled={diffZoom >= DIFF_ZOOM_MAX}
            onClick={() => setDiffZoom((z) => Math.min(DIFF_ZOOM_MAX, z + DIFF_ZOOM_STEP))}
            className="flex size-6 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlusIcon className="size-[1em]" />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-[length:var(--app-code-font-size)] text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-[length:var(--app-code-font-size)] text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-[length:var(--app-code-font-size)] text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : selectedTurnRequestedButMissing ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-[length:var(--app-code-font-size)] text-muted-foreground/70">
          The selected turn is unavailable. It may have been removed by a revert or is no longer
          present in this thread.
        </div>
      ) : selectedTurnRangeMissing ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-[length:var(--app-code-font-size)] text-muted-foreground/70">
          A diff for this turn is not yet available. Checkpoint metadata is missing.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[length:var(--app-code-font-size)] text-red-500/80">
                  {checkpointDiffError}
                </p>
              </div>
            )}
            {displayDiffState?._tag === "stale" && renderablePatch && (
              <div className="px-3 pt-2">
                <p className="rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[length:var(--app-code-font-size)] text-muted-foreground/75">
                  Showing the last loaded diff while the latest checkpoint is unavailable:{" "}
                  {displayDiffState.message}
                </p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingCheckpointDiff ? (
                <DiffPanelLoadingState label="Loading checkpoint diff..." />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-[length:var(--app-code-font-size)] text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  const collapsed = collapsedDiffFileKeys.has(fileKey);
                  const safety = diffSafetyByPath.get(filePath);
                  const safetyLabel = diffFileSafetyLabel(safety);
                  if (safety?.size === "unrenderable") {
                    return (
                      <div
                        key={themedFileKey}
                        data-diff-file-path={filePath}
                        className="diff-render-file mb-2 rounded-md border border-border/70 bg-background/70 p-3 first:mt-2 last:mb-0"
                      >
                        <button
                          type="button"
                          className="mb-2 block max-w-full truncate font-mono text-[length:var(--app-code-font-size)] text-foreground underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
                          onClick={() => openDiffFileInEditor(filePath)}
                          title={filePath}
                        >
                          {filePath}
                        </button>
                        <p className="text-[length:var(--app-code-font-size)] text-muted-foreground/80">
                          {safetyLabel ?? "Diff is not renderable."}
                        </p>
                      </div>
                    );
                  }
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
                        openDiffFileInEditor(filePath);
                      }}
                    >
                      {safetyLabel && (
                        <div className="rounded-t-md border border-b-0 border-border/70 bg-background/70 px-3 py-1 text-[length:var(--app-code-font-size)] text-muted-foreground/75">
                          {safetyLabel}
                        </div>
                      )}
                      <FileDiff
                        fileDiff={fileDiff}
                        renderHeaderPrefix={() => (
                          <button
                            type="button"
                            className={cn(
                              "inline-flex size-[1.25em] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                              getDiffCollapseIconClassName(fileDiff),
                            )}
                            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                            aria-expanded={!collapsed}
                            title={collapsed ? "Expand diff" : "Collapse diff"}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleDiffFileCollapsed(fileKey);
                            }}
                          >
                            {collapsed ? (
                              <ChevronRightIcon className="size-[1em]" />
                            ) : (
                              <ChevronDownIcon className="size-[1em]" />
                            )}
                          </button>
                        )}
                        options={{
                          collapsed,
                          diffStyle: diffRenderMode === "split" ? "split" : "unified",
                          lineDiffType: "none",
                          overflow: diffWordWrap ? "wrap" : "scroll",
                          theme: resolveDiffThemeName(resolvedTheme),
                          themeType: resolvedTheme as DiffThemeType,
                          unsafeCSS: diffUnsafeCss,
                        }}
                      />
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[length:var(--app-code-font-size)] text-muted-foreground/75">
                    {renderablePatch.reason}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                    style={diffRawTextStyle}
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
