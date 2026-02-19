import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns2Icon, Rows3Icon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { checkpointDiffQueryOptions, providerQueryKeys } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { isElectron } from "../env";
import { useNativeApi } from "../hooks/useNativeApi";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { formatTimestamp } from "../session-logic";
import { useStore } from "../store";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";

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
  const queryClient = useQueryClient();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
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

  useEffect(() => {
    if (!activeThread?.id || !selectedTurn || !selectedTurnCheckpointDiff) {
      return;
    }
    dispatch({
      type: "SET_THREAD_TURN_CHECKPOINT_DIFFS",
      threadId: activeThread.id,
      checkpointDiffByTurnId: {
        [selectedTurn.turnId]: selectedTurnCheckpointDiff,
      },
    });
  }, [activeThread?.id, dispatch, selectedTurn, selectedTurnCheckpointDiff]);

  const selectedPatch = useMemo(() => {
    const patchForSummary = (summary: (typeof turnDiffSummaries)[number]): string | undefined => {
      const checkpointTurnCount =
        summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (activeSessionId && typeof checkpointTurnCount === "number") {
        const checkpointPatch = queryClient.getQueryData<{ diff: string }>(
          providerQueryKeys.checkpointDiff({
            sessionId: activeSessionId,
            threadRuntimeId: activeThreadRuntimeId,
            fromTurnCount: Math.max(0, checkpointTurnCount - 1),
            toTurnCount: checkpointTurnCount,
            cacheScope: `turn:${summary.turnId}`,
          }),
        )?.diff;
        if (checkpointPatch) {
          return checkpointPatch;
        }
      }
      if (summary.unifiedDiff) {
        return summary.unifiedDiff;
      }
      const filePatches = summary.files
        .map((file) => file.diff?.trim())
        .filter((patch): patch is string => Boolean(patch));
      if (filePatches.length === 0) {
        return undefined;
      }
      return filePatches.join("\n\n");
    };

    if (selectedTurn) {
      return selectedTurnCheckpointDiff ?? patchForSummary(selectedTurn);
    }

    if (conversationCheckpointDiff) {
      return conversationCheckpointDiff;
    }

    // Fallback when a conversation checkpoint diff isn't available yet:
    // keep one patch per file path (latest change wins) so files aren't duplicated.
    const latestPatchByPath = new Map<string, string>();
    for (const summary of turnDiffSummaries) {
      for (const file of summary.files) {
        if (latestPatchByPath.has(file.path)) {
          continue;
        }
        const patch = file.diff?.trim();
        if (!patch) {
          continue;
        }
        latestPatchByPath.set(file.path, patch);
      }
    }
    if (latestPatchByPath.size > 0) {
      return Array.from(latestPatchByPath.entries())
        .toSorted(([leftPath], [rightPath]) =>
          leftPath.localeCompare(rightPath, undefined, { numeric: true, sensitivity: "base" }),
        )
        .map(([, patch]) => patch)
        .join("\n\n");
    }

    const patches = turnDiffSummaries
      .toReversed()
      .map((summary) => patchForSummary(summary)?.trim())
      .filter((patch): patch is string => Boolean(patch));
    if (patches.length === 0) {
      return undefined;
    }
    return patches.join("\n\n");
  }, [
    activeSessionId,
    activeThreadRuntimeId,
    conversationCheckpointDiff,
    inferredCheckpointTurnCountByTurnId,
    queryClient,
    selectedTurn,
    selectedTurnCheckpointDiff,
    turnDiffSummaries,
  ]);
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
          "flex items-center justify-between border-b border-border px-4",
          shouldUseDragRegion ? "drag-region h-[52px]" : "py-3",
        )}
      >
        <div className="flex gap-1.5 overflow-x-auto pb-0.5">
          <button type="button" className="shrink-0 rounded-md" onClick={selectWholeConversation}>
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] font-medium">All turns</div>
              <div className="text-[8px] opacity-70">Conversation</div>
            </div>
          </button>
          {turnDiffSummaries.map((summary, index) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="text-[10px] font-medium">
                  Turn {turnDiffSummaries.length - index}
                </div>
                <div className="text-[8px] opacity-70">{formatTimestamp(summary.completedAt)}</div>
              </div>
            </button>
          ))}
        </div>
        <ToggleGroup
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
          <div ref={patchViewportRef} className="min-w-0 flex-1 overflow-auto px-3 py-2">
            {!canApplyStoredTarget && state.diffThreadId && (
              <p className="mb-2 text-[11px] text-muted-foreground/65">
                Showing diffs for the active thread.
              </p>
            )}
            {checkpointDiffError && !renderablePatch && (
              <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
            )}
            {!renderablePatch ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground/70">
                {isLoadingCheckpointDiff
                  ? "Loading checkpoint diff..."
                  : "No patch available for this selection."}
              </div>
            ) : renderablePatch.kind === "files" ? (
              <div className="space-y-3">
                {renderableFiles.map((fileDiff) => (
                  <div
                    key={fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`}
                    data-diff-file-path={resolveFileDiffPath(fileDiff)}
                    className="rounded-md"
                  >
                    <FileDiff
                      fileDiff={fileDiff}
                      options={{
                        diffStyle: diffRenderMode === "split" ? "split" : "unified",
                        lineDiffType: "none",
                        themeType: resolvedTheme,
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                <pre className="max-h-[72vh] overflow-auto rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
                  {renderablePatch.text}
                </pre>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
