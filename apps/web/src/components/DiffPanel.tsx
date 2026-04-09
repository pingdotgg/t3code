import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  GitBranchIcon,
  HistoryIcon,
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
import { useGitStatus } from "~/lib/gitStatusState";
import { gitDiffQueryOptions } from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { parseDiffRouteSearch, stripDiffSearchParams, type DiffScope } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { createThreadSelector } from "../storeSelectors";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

const DIFF_SCOPE_STORAGE_KEY = "t3code:diff-panel-scope";
const DEFAULT_DIFF_SCOPE: DiffScope = "git";

function getWorkingTreeCollapsedStorageKey(cwd: string): string {
  return `t3code:diff-panel:git-collapsed:${cwd}`;
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

function splitFileDiffPath(filePath: string): { directory: string | null; fileName: string } {
  const normalizedPath = filePath.replace(/\/+$/, "");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  if (lastSlashIndex === -1) {
    return { directory: null, fileName: normalizedPath };
  }
  return {
    directory: normalizedPath.slice(0, lastSlashIndex + 1),
    fileName: normalizedPath.slice(lastSlashIndex + 1),
  };
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function getFileDiffLineStats(fileDiff: FileDiffMetadata) {
  return fileDiff.hunks.reduce(
    (totals, hunk) => ({
      additions: totals.additions + hunk.additionLines,
      deletions: totals.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

function getFileDiffChangeLabel(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "Added";
    case "deleted":
      return "Removed";
    case "rename-pure":
      return "Renamed";
    case "rename-changed":
      return "Renamed and modified";
    default:
      return "Modified";
  }
}

function getFileDiffNameClasses(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-emerald-600 dark:text-emerald-400";
    case "deleted":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-foreground";
  }
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [rememberedDiffScope, setRememberedDiffScope] = useState<DiffScope>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_DIFF_SCOPE;
    }
    const storedValue = window.localStorage.getItem(DIFF_SCOPE_STORAGE_KEY);
    return storedValue === "session" || storedValue === "git" ? storedValue : DEFAULT_DIFF_SCOPE;
  });
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const [collapsedFileKeys, setCollapsedFileKeys] = useState<Set<string>>(() => new Set());
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const diffScope = diffSearch.diffScope ?? rememberedDiffScope;
  const isSessionDiffScope = diffScope === "session";
  const activeThreadId = routeThreadId;
  const activeThread = useStore(
    useMemo(() => createThreadSelector(activeThreadId), [activeThreadId]),
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projectById[activeProjectId] : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitStatusQuery = useGitStatus(activeCwd ?? null);
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

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  const selectedFilePath = selectedTurnId !== null ? (diffSearch.diffFilePath ?? null) : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
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
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && isSessionDiffScope,
    }),
  );
  const gitDiffQuery = useQuery({
    ...gitDiffQueryOptions(activeCwd ?? null),
    enabled: isGitRepo && !isSessionDiffScope && activeCwd !== null,
  });
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;
  const gitDiffError =
    gitDiffQuery.error instanceof Error
      ? gitDiffQuery.error.message
      : gitDiffQuery.error
        ? "Failed to load git diff."
        : null;

  const selectedPatch = isSessionDiffScope
    ? selectedTurn
      ? selectedTurnCheckpointDiff
      : conversationCheckpointDiff
    : gitDiffQuery.data?.diff;
  const activeDiffError = isSessionDiffScope ? checkpointDiffError : gitDiffError;
  const isLoadingSelectedPatch = isSessionDiffScope
    ? activeCheckpointDiffQuery.isLoading
    : gitDiffQuery.isLoading;
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
  const totalDiffLineStats = useMemo(
    () =>
      renderableFiles.reduce(
        (totals, fileDiff) => {
          const lineStats = getFileDiffLineStats(fileDiff);
          return {
            additions: totals.additions + lineStats.additions,
            deletions: totals.deletions + lineStats.deletions,
          };
        },
        { additions: 0, deletions: 0 },
      ),
    [renderableFiles],
  );

  const allDiffCardsCollapsed =
    renderableFiles.length > 0 &&
    renderableFiles.every((fileDiff) => collapsedFileKeys.has(buildFileDiffRenderKey(fileDiff)));

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  useEffect(() => {
    if (!isSessionDiffScope) {
      return;
    }
    setCollapsedFileKeys(new Set());
  }, [isSessionDiffScope, selectedPatch]);

  useEffect(() => {
    if (isSessionDiffScope || typeof window === "undefined") {
      return;
    }
    if (!activeCwd) {
      setCollapsedFileKeys(new Set());
      return;
    }

    const rawValue = window.localStorage.getItem(getWorkingTreeCollapsedStorageKey(activeCwd));
    if (!rawValue) {
      setCollapsedFileKeys(new Set());
      return;
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) {
        setCollapsedFileKeys(new Set());
        return;
      }
      setCollapsedFileKeys(
        new Set(parsed.filter((value): value is string => typeof value === "string")),
      );
    } catch {
      setCollapsedFileKeys(new Set());
    }
  }, [activeCwd, isSessionDiffScope]);

  useEffect(() => {
    setRememberedDiffScope(diffScope);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DIFF_SCOPE_STORAGE_KEY, diffScope);
    }
  }, [diffScope]);

  useEffect(() => {
    if (isSessionDiffScope || typeof window === "undefined" || !activeCwd) {
      return;
    }
    window.localStorage.setItem(
      getWorkingTreeCollapsedStorageKey(activeCwd),
      JSON.stringify([...collapsedFileKeys]),
    );
  }, [activeCwd, collapsedFileKeys, isSessionDiffScope]);

  useEffect(() => {
    if (!isSessionDiffScope || !selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [isSessionDiffScope, selectedFilePath, renderableFiles]);

  const selectDiffScope = useCallback(
    (nextScope: DiffScope) => {
      if (!activeThread) return;
      void navigate({
        to: "/$threadId",
        params: { threadId: activeThread.id },
        search: (previous) => ({ ...previous, diff: "1", diffScope: nextScope }),
      });
    },
    [activeThread, navigate],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffScope: "session", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffScope: "session" };
      },
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

  const toggleFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedFileKeys((previous) => {
      const next = new Set(previous);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  const toggleAllDiffCards = useCallback(() => {
    setCollapsedFileKeys((previous) => {
      const shouldExpandAll = renderableFiles.every((fileDiff) =>
        previous.has(buildFileDiffRenderKey(fileDiff)),
      );
      if (shouldExpandAll) {
        return new Set();
      }
      return new Set(renderableFiles.map((fileDiff) => buildFileDiffRenderKey(fileDiff)));
    });
  }, [renderableFiles]);

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

  const headerLead = isSessionDiffScope ? (
    <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
      {canScrollTurnStripLeft && (
        <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
      )}
      {canScrollTurnStripRight && (
        <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
      )}
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
        <ChevronLeftIcon className="size-3.5" />
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
        <ChevronRightIcon className="size-3.5" />
      </button>
      <div
        ref={turnStripRef}
        className="turn-chip-strip flex gap-1 overflow-x-auto px-8 py-0.5"
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
            <div className="text-[10px] leading-tight font-medium">All turns</div>
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
                <span className="text-[10px] leading-tight font-medium">
                  Turn{" "}
                  {summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                    "?"}
                </span>
                <span className="text-[9px] leading-tight opacity-70">
                  {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  ) : (
    <div className="min-w-0 flex-1 px-1 [-webkit-app-region:no-drag]">
      <div className="flex items-center gap-2 overflow-x-auto py-0.5">
        <div className="shrink-0 rounded-md border border-border bg-accent px-2 py-1 text-left text-[10px] leading-tight font-medium text-accent-foreground">
          Working Tree
        </div>
        <div className="shrink-0 px-0.5 text-[11px] font-medium">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{totalDiffLineStats.additions}
          </span>
          <span className="px-1" aria-hidden="true" />
          <span className="text-rose-600 dark:text-rose-400">-{totalDiffLineStats.deletions}</span>
        </div>
      </div>
    </div>
  );

  const headerRow = (
    <>
      {headerLead}
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[diffScope]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "session" || next === "git") {
              selectDiffScope(next);
            }
          }}
        >
          <Toggle aria-label="Show session diff" title="Show session diff" value="session">
            <HistoryIcon className="size-3" />
          </Toggle>
          <Toggle aria-label="Show full git diff" title="Show full git diff" value="git">
            <GitBranchIcon className="size-3" />
          </Toggle>
        </ToggleGroup>
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
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={allDiffCardsCollapsed ? "Expand all diff cards" : "Collapse all diff cards"}
          title={allDiffCardsCollapsed ? "Expand all" : "Collapse all"}
          variant="outline"
          size="xs"
          disabled={renderableFiles.length === 0}
          pressed={allDiffCardsCollapsed}
          onPressedChange={() => {
            toggleAllDiffCards();
          }}
        >
          {allDiffCardsCollapsed ? (
            <ChevronRightIcon className="size-3" />
          ) : (
            <ChevronDownIcon className="size-3" />
          )}
        </Toggle>
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
          <TextWrapIcon className="size-3" />
        </Toggle>
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
      ) : isSessionDiffScope && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {activeDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{activeDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={isSessionDiffScope ? "Loading checkpoint diff..." : "Loading git diff..."}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? isSessionDiffScope
                        ? "No net changes in this selection."
                        : "Git reports no working tree changes."
                      : !isSessionDiffScope
                        ? "Git reports no working tree changes."
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
                  const { directory, fileName } = splitFileDiffPath(filePath);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  const diffBodyId = `diff-card-${themedFileKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                  const isCollapsed = collapsedFileKeys.has(fileKey);
                  const lineStats = getFileDiffLineStats(fileDiff);
                  const changeLabel = getFileDiffChangeLabel(fileDiff);
                  return (
                    <section
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file mb-1.5 overflow-hidden rounded-md border border-border/70 bg-card/70 shadow-xs first:mt-2 last:mb-0"
                    >
                      <div className="flex min-h-8 items-center gap-2 px-2.5 py-0.75">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => toggleFileCollapsed(fileKey)}
                          aria-expanded={!isCollapsed}
                          aria-controls={diffBodyId}
                        >
                          {isCollapsed ? (
                            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          ) : (
                            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          )}
                          <VscodeEntryIcon
                            pathValue={filePath}
                            kind="file"
                            theme={resolvedTheme}
                            className="size-3.5"
                          />
                          <span className="min-w-0 truncate text-[13px] leading-none">
                            {directory ? (
                              <>
                                <span className="text-muted-foreground/80">{directory}</span>
                                <span
                                  className={cn("font-medium", getFileDiffNameClasses(fileDiff))}
                                >
                                  {fileName}
                                </span>
                              </>
                            ) : (
                              <span className={cn("font-medium", getFileDiffNameClasses(fileDiff))}>
                                {fileName}
                              </span>
                            )}
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <div
                            className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium"
                            title={changeLabel}
                            aria-label={changeLabel}
                          >
                            <span className="text-emerald-600 dark:text-emerald-400">
                              +{lineStats.additions}
                            </span>
                            <span className="text-rose-600 dark:text-rose-400">
                              -{lineStats.deletions}
                            </span>
                          </div>
                        </div>
                      </div>
                      {!isCollapsed && (
                        <div id={diffBodyId} className="border-t border-border/60 bg-background/20">
                          <FileDiff
                            fileDiff={fileDiff}
                            options={{
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              disableFileHeader: true,
                              lineDiffType: "none",
                              overflow: diffWordWrap ? "wrap" : "scroll",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                            }}
                          />
                        </div>
                      )}
                    </section>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
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
