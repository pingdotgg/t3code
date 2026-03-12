import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ThreadId, type TurnId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  FolderXIcon,
  GitBranchIcon,
  LoaderIcon,
  Rows3Icon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  gitBranchesQueryOptions,
  gitCreateWorktreeMutationOptions,
  gitDiffBranchQueryOptions,
} from "~/lib/gitReactQuery";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../nativeApi";
import { preferredTerminalEditor, resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey, DIFF_UNSAFE_CSS, resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";


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

function formatTurnChipTimestamp(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

interface DiffPanelProps {
  mode?: "inline" | "sheet" | "sidebar";
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const toggleFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const activeThreadId = routeThreadId;
  const activeThread = useStore((store) =>
    activeThreadId ? store.threads.find((thread) => thread.id === activeThreadId) : undefined,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useStore((store) =>
    activeProjectId ? store.projects.find((project) => project.id === activeProjectId) : undefined,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd;
  const gitBranchesQuery = useQuery(gitBranchesQueryOptions(activeCwd ?? null));
  const isGitRepo = gitBranchesQuery.data?.isRepo ?? true;
  const defaultBranchName = useMemo(() => {
    const branches = gitBranchesQuery.data?.branches;
    if (!branches) return null;
    return branches.find((b) => b.isDefault)?.name ?? null;
  }, [gitBranchesQuery.data?.branches]);
  const showBranchDiff = diffSearch.diffBranch === "1";
  const branchDiffQuery = useQuery(
    gitDiffBranchQueryOptions({
      cwd: activeCwd ?? null,
      base: showBranchDiff ? defaultBranchName : null,
    }),
  );
  const branchDiffPatch = useMemo(
    () => (showBranchDiff ? getRenderablePatch(branchDiffQuery.data?.diff, `branch-diff:${resolvedTheme}`) : null),
    [showBranchDiff, branchDiffQuery.data?.diff, resolvedTheme],
  );
  const branchDiffFiles = useMemo(() => {
    if (!branchDiffPatch || branchDiffPatch.kind !== "files") return [];
    return branchDiffPatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [branchDiffPatch]);
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
      enabled: isGitRepo,
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;

  const worktreePath = activeThread?.worktreePath ?? null;
  const isWorktreeMissing =
    !!worktreePath &&
    !!checkpointDiffError &&
    (checkpointDiffError.includes("ENOENT") ||
      checkpointDiffError.includes("NotFound") ||
      checkpointDiffError.includes("no such file"));
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const handleRecreateWorktree = useCallback(() => {
    if (!activeProject || !activeThread?.branch) return;
    createWorktreeMutation.mutate(
      {
        cwd: activeProject.cwd,
        branch: activeThread.branch,
        newBranch: activeThread.branch,
        path: worktreePath,
      },
      {
        onSuccess: () => {
          void activeCheckpointDiffQuery.refetch();
        },
      },
    );
  }, [activeProject, activeThread?.branch, createWorktreeMutation, worktreePath, activeCheckpointDiffQuery]);

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
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

  // Reset collapsed state when the diff selection changes
  useEffect(() => {
    setCollapsedFiles(new Set());
  }, [renderableFiles]);

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
      const api = readNativeApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void api.shell.openInEditor(targetPath, preferredTerminalEditor()).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$threadId",
      params: { threadId: activeThread.id },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
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
        return { ...rest, diff: "1" };
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

  const shouldUseDragRegion = isElectron && mode !== "sheet";
  const headerRow = (
    <>
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
            data-turn-chip-selected={selectedTurnId === null && !showBranchDiff}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null && !showBranchDiff
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
                    {formatTurnChipTimestamp(summary.completedAt)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      {defaultBranchName && (
        <button
          type="button"
          className={cn(
            "shrink-0 rounded-md [-webkit-app-region:no-drag]",
          )}
          onClick={() => {
            if (!activeThread) return;
            void navigate({
              to: "/$threadId",
              params: { threadId: activeThread.id },
              search: (previous) => {
                const rest = stripDiffSearchParams(previous);
                return { ...rest, diff: "1" as const, ...(!showBranchDiff ? { diffBranch: "1" as const } : {}) };
              },
            });
          }}
          title={`Show full diff to ${defaultBranchName}`}
        >
          <div
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1 transition-colors",
              showBranchDiff
                ? "border-border bg-accent text-accent-foreground"
                : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
            )}
          >
            <GitBranchIcon className="size-2.5" />
            <span className="text-[10px] leading-tight font-medium">Diff to {defaultBranchName}</span>
          </div>
        </button>
      )}
      <ToggleGroup
        className="shrink-0 [-webkit-app-region:no-drag]"
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
    </>
  );
  const headerRowClassName = cn(
    "flex items-center justify-between gap-2 px-4",
    shouldUseDragRegion ? "drag-region h-[52px] border-b border-border" : "h-12",
  );

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      {shouldUseDragRegion ? (
        <div className={headerRowClassName}>{headerRow}</div>
      ) : (
        <div className="border-b border-border">
          <div className={headerRowClassName}>{headerRow}</div>
        </div>
      )}

      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : isWorktreeMissing ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FolderXIcon className="size-8 text-muted-foreground/40" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground/80">Worktree not found</p>
            <p className="text-xs text-muted-foreground/70">
              The worktree for this thread was deleted. Recreate it to view diffs again.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={createWorktreeMutation.isPending || !activeThread?.branch}
            onClick={handleRecreateWorktree}
          >
            {createWorktreeMutation.isPending ? (
              <>
                <LoaderIcon className="size-3.5 animate-spin" />
                Recreating...
              </>
            ) : (
              "Recreate Worktree"
            )}
          </Button>
          {createWorktreeMutation.isError && (
            <p className="text-[11px] text-destructive">
              {createWorktreeMutation.error instanceof Error
                ? createWorktreeMutation.error.message
                : "Failed to recreate worktree."}
            </p>
          )}
        </div>
      ) : showBranchDiff ? (
        branchDiffQuery.isLoading ? (
          <div className="flex flex-1 items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
            <p>Loading branch diff...</p>
          </div>
        ) : branchDiffQuery.isError ? (
          <div className="flex-1 px-3 pt-2">
            <p className="text-[11px] text-red-500/80">
              {branchDiffQuery.error instanceof Error
                ? branchDiffQuery.error.message
                : "Failed to load branch diff."}
            </p>
          </div>
        ) : !branchDiffPatch ? (
          <div className="flex flex-1 items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
            <p>No changes compared to {defaultBranchName}.</p>
          </div>
        ) : branchDiffPatch.kind === "files" ? (
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <Virtualizer
              className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
              config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
            >
              {branchDiffFiles.map((fileDiff) => {
                const filePath = resolveFileDiffPath(fileDiff);
                const fileKey = buildFileDiffRenderKey(fileDiff);
                const themedFileKey = `${fileKey}:${resolvedTheme}`;
                const isCollapsed = collapsedFiles.has(themedFileKey);
                return (
                  <div
                    key={themedFileKey}
                    data-diff-file-path={filePath}
                    className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                  >
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-1.5 border-b border-border/60 bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground))] px-3 py-1.5 text-left text-[12px] font-medium text-foreground/90 transition-colors hover:bg-[color-mix(in_srgb,var(--card)_88%,var(--foreground))] hover:text-foreground"
                      onClick={() => toggleFileCollapsed(themedFileKey)}
                      title={filePath}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
                          isCollapsed && "-rotate-90",
                        )}
                      />
                      <span className="min-w-0 truncate font-mono">{filePath}</span>
                    </button>
                    {!isCollapsed && (
                      <div
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
                        <FileDiff
                          fileDiff={fileDiff}
                          options={{
                            diffStyle: diffRenderMode === "split" ? "split" : "unified",
                            lineDiffType: "none",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme as DiffThemeType,
                            unsafeCSS: DIFF_UNSAFE_CSS,
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </Virtualizer>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground/75">{branchDiffPatch.reason}</p>
              <pre className="overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground/90">
                {branchDiffPatch.text}
              </pre>
            </div>
          </div>
        )
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
              </div>
            )}
            {!renderablePatch ? (
              <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                <p>
                  {isLoadingCheckpointDiff
                    ? "Loading checkpoint diff..."
                    : hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                </p>
              </div>
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
                  const isCollapsed = collapsedFiles.has(themedFileKey);
                  return (
                    <div
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
                    >
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center gap-1.5 border-b border-border/60 bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground))] px-3 py-1.5 text-left text-[12px] font-medium text-foreground/90 transition-colors hover:bg-[color-mix(in_srgb,var(--card)_88%,var(--foreground))] hover:text-foreground"
                        onClick={() => toggleFileCollapsed(themedFileKey)}
                        title={filePath}
                      >
                        <ChevronDownIcon
                          className={cn(
                            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
                            isCollapsed && "-rotate-90",
                          )}
                        />
                        <span className="min-w-0 truncate font-mono">{filePath}</span>
                      </button>
                      {!isCollapsed && (
                        <div
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
                          <FileDiff
                            fileDiff={fileDiff}
                            options={{
                              diffStyle: diffRenderMode === "split" ? "split" : "unified",
                              lineDiffType: "none",
                              theme: resolveDiffThemeName(resolvedTheme),
                              themeType: resolvedTheme as DiffThemeType,
                              unsafeCSS: DIFF_UNSAFE_CSS,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre className="max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
