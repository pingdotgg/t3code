import { parsePatchFiles } from "@pierre/diffs";
import {
  FileDiff,
  type FileDiffMetadata,
  Virtualizer,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, Columns2Icon, Rows3Icon } from "lucide-react";
import {
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { isElectron } from "../env";
import { useNativeApi } from "../hooks/useNativeApi";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark" | "system";

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

function getRenderablePatch(patch: string | undefined): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(normalizedPatch, buildPatchCacheKey(normalizedPatch));
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
  mode?: "inline" | "sheet";
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const workerPoolSize = useMemo(() => {
    const cores = typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () =>
          new Worker(new URL("../workers/diffs.worker.ts", import.meta.url), { type: "module" }),
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      }}
      highlighterOptions={{
        tokenizeMaxLineLength: 1_000,
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const api = useNativeApi();
  const { resolvedTheme } = useTheme();
  const { state, dispatch } = useStore();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
  const params = useParams({ strict: false });
  const routeThreadId = typeof params.threadId === "string" ? params.threadId : null;
  const activeThreadId = state.diffThreadId ?? routeThreadId;
  const activeThread = state.threads.find((thread) => thread.id === activeThreadId);
  const activeThreadRuntimeId =
    activeThread?.codexThreadId ?? activeThread?.session?.threadId ?? null;
  const activeSessionId = activeThread?.session?.sessionId ?? null;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);

  const canApplyStoredTarget = Boolean(activeThread && state.diffThreadId === activeThread.id);
  const selectedTurnId = canApplyStoredTarget ? state.diffTurnId : null;
  const selectedFilePath =
    canApplyStoredTarget && selectedTurnId !== null ? state.diffFilePath : null;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (turnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        turnDiffSummaries[0]);
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
    const turnCounts = turnDiffSummaries
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
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries]);
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
    if (selectedTurn || turnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${turnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [selectedTurn, turnDiffSummaries]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions(api, {
      sessionId: activeSessionId,
      threadRuntimeId: activeThreadRuntimeId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
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

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const renderablePatch = useMemo(() => getRenderablePatch(selectedPatch), [selectedPatch]);
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

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const selectTurn = (turnId: string) => {
    if (!activeThread) return;
    dispatch({
      type: "SET_DIFF_TARGET",
      threadId: activeThread.id,
      turnId,
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    dispatch({
      type: "SET_DIFF_TARGET",
      threadId: activeThread.id,
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

    updateTurnStripScrollState();
    const onScroll = () => updateTurnStripScrollState();
    element.addEventListener("scroll", onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => updateTurnStripScrollState());
    resizeObserver.observe(element);

    return () => {
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
    };
  }, [updateTurnStripScrollState]);

  useEffect(() => {
    updateTurnStripScrollState();
  }, [turnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;

    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId]);

  const shouldUseDragRegion = isElectron && mode === "inline";

  return (
    <aside
      className={cn(
        "flex h-full min-w-0 flex-col bg-card",
        mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b border-border px-4",
          shouldUseDragRegion ? "drag-region h-[52px]" : "py-3",
        )}
      >
        <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
          {canScrollTurnStripLeft && (
            <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-gradient-to-r from-card to-transparent" />
          )}
          {canScrollTurnStripRight && (
            <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-gradient-to-l from-card to-transparent" />
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
            {turnDiffSummaries.map((summary, index) => (
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
                      Turn {turnDiffSummaries.length - index}
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
      </div>

      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : turnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div ref={patchViewportRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {!canApplyStoredTarget && state.diffThreadId && (
              <div className="px-3 pt-2">
                <p className="mb-2 text-[11px] text-muted-foreground/65">
                  Showing diffs for the active thread.
                </p>
              </div>
            )}
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
                    : "No patch available for this selection."}
                </p>
              </div>
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="h-full min-h-0 overflow-auto px-3 py-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  return (
                    <div key={fileKey} data-diff-file-path={filePath} className="rounded-md">
                      <FileDiff
                        fileDiff={fileDiff}
                        options={{
                          diffStyle: diffRenderMode === "split" ? "split" : "unified",
                          lineDiffType: "none",
                          themeType: resolvedTheme as DiffThemeType,
                        }}
                      />
                    </div>
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto px-3 py-2">
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
    </aside>
  );
}
