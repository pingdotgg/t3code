import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ThreadId, TimestampFormat, TurnId } from "@t3tools/contracts";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import {
  type WheelEvent as ReactWheelEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { useGitStatusIsRepo } from "~/lib/gitStatusState";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { selectProjectByRef, useStore } from "../store";
import {
  type ThreadBranchToolbarSnapshot,
  createThreadBranchToolbarSnapshotSelectorByRef,
  createThreadTurnDiffSummariesSelectorByRef,
} from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import type { TurnDiffSummary } from "../types";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
type DiffThemeType = "light" | "dark";

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

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

const DiffPanelHeader = memo(function DiffPanelHeader(props: {
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
  onDiffRenderModeChange: (next: DiffRenderMode) => void;
  onDiffWordWrapChange: (next: boolean) => void;
  onSelectTurn: (turnId: TurnId) => void;
  onSelectWholeConversation: () => void;
  orderedTurnDiffSummaries: TurnDiffSummary[];
  selectedTurnId: TurnId | null;
  timestampFormat: TimestampFormat;
}) {
  const {
    diffRenderMode,
    diffWordWrap,
    inferredCheckpointTurnCountByTurnId,
    onDiffRenderModeChange,
    onDiffWordWrapChange,
    onSelectTurn,
    onSelectWholeConversation,
    orderedTurnDiffSummaries,
    selectedTurnId,
    timestampFormat,
  } = props;
  const turnStripRef = useRef<HTMLDivElement>(null);
  const [turnStripScrollState, setTurnStripScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  });

  const updateTurnStripScrollState = useCallback(() => {
    const element = turnStripRef.current;
    if (!element) {
      setTurnStripScrollState((previous) =>
        previous.canScrollLeft || previous.canScrollRight
          ? { canScrollLeft: false, canScrollRight: false }
          : previous,
      );
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    const nextCanScrollLeft = element.scrollLeft > 4;
    const nextCanScrollRight = element.scrollLeft < maxScrollLeft - 4;
    setTurnStripScrollState((previous) =>
      previous.canScrollLeft === nextCanScrollLeft && previous.canScrollRight === nextCanScrollRight
        ? previous
        : {
            canScrollLeft: nextCanScrollLeft,
            canScrollRight: nextCanScrollRight,
          },
    );
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
  }, [selectedTurnId]);

  return (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        {turnStripScrollState.canScrollLeft && (
          <div className="pointer-events-none absolute inset-y-0 left-8 z-10 w-7 bg-linear-to-r from-card to-transparent" />
        )}
        {turnStripScrollState.canScrollRight && (
          <div className="pointer-events-none absolute inset-y-0 right-8 z-10 w-7 bg-linear-to-l from-card to-transparent" />
        )}
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            turnStripScrollState.canScrollLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!turnStripScrollState.canScrollLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            turnStripScrollState.canScrollRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!turnStripScrollState.canScrollRight}
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
            onClick={onSelectWholeConversation}
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
              onClick={() => onSelectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurnId
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
                    {formatShortTimestamp(summary.completedAt, timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="outline"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              onDiffRenderModeChange(next);
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
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            onDiffWordWrapChange(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
      </div>
    </>
  );
});

const DiffPanelContent = memo(function DiffPanelContent(props: {
  activeThreadId: ThreadId | null;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  orderedTurnDiffSummaries: TurnDiffSummary[];
  selectedFilePath: string | null;
  selectedTurnId: TurnId | null;
  workspaceSnapshot: ThreadBranchToolbarSnapshot | undefined;
}) {
  const {
    activeThreadId,
    diffRenderMode,
    diffWordWrap,
    orderedTurnDiffSummaries,
    selectedFilePath,
    selectedTurnId,
    workspaceSnapshot,
  } = props;
  const { resolvedTheme } = useTheme();
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const activeProject = useStore((store) =>
    workspaceSnapshot
      ? selectProjectByRef(store, {
          environmentId: workspaceSnapshot.environmentId,
          projectId: workspaceSnapshot.projectId,
        })
      : undefined,
  );
  const activeCwd = workspaceSnapshot?.worktreePath ?? activeProject?.cwd ?? null;
  const isGitRepo = useGitStatusIsRepo({
    environmentId: workspaceSnapshot?.environmentId ?? null,
    cwd: activeCwd,
  });
  const { inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(orderedTurnDiffSummaries);
  const activeCheckpointSelection = useMemo(() => {
    const selectedTurn =
      selectedTurnId === null
        ? undefined
        : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
          orderedTurnDiffSummaries[0]);
    const selectedCheckpointTurnCount =
      selectedTurn &&
      (selectedTurn.checkpointTurnCount ??
        inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
    const selectedCheckpointRange =
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null;
    const conversationCheckpointTurnCount = (() => {
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
    })();
    const conversationCheckpointRange =
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null;

    return {
      conversationCacheScope:
        selectedTurn || orderedTurnDiffSummaries.length === 0
          ? null
          : `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`,
      selectedTurn,
      activeCheckpointRange: selectedTurn ? selectedCheckpointRange : conversationCheckpointRange,
    };
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries, selectedTurnId]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: workspaceSnapshot?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointSelection.activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointSelection.activeCheckpointRange?.toTurnCount ?? null,
      cacheScope: activeCheckpointSelection.selectedTurn
        ? `turn:${activeCheckpointSelection.selectedTurn.turnId}`
        : activeCheckpointSelection.conversationCacheScope,
      enabled: isGitRepo,
    }),
  );
  const selectedPatch = activeCheckpointDiffQuery.data?.diff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;
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

  if (!workspaceSnapshot) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Select a thread to inspect turn diffs.
      </div>
    );
  }

  if (!isGitRepo) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Turn diffs are unavailable because this project is not a git repository.
      </div>
    );
  }

  if (orderedTurnDiffSummaries.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        No completed turns yet.
      </div>
    );
  }

  return (
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
        activeCheckpointDiffQuery.isLoading ? (
          <DiffPanelLoadingState label="Loading checkpoint diff..." />
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
            return (
              <div
                key={themedFileKey}
                data-diff-file-path={filePath}
                className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
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
                    overflow: diffWordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme as DiffThemeType,
                    unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                  }}
                />
              </div>
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
  );
});

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const navigate = useNavigate();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const previousDiffOpenRef = useRef(false);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const workspaceSnapshot = useStore(
    useMemo(() => createThreadBranchToolbarSnapshotSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const turnDiffSummaries = useStore(
    useMemo(() => createThreadTurnDiffSummariesSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const { inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(turnDiffSummaries);
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

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  const selectTurn = useCallback(
    (turnId: TurnId) => {
      if (!routeThreadRef) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(routeThreadRef.environmentId, routeThreadRef.threadId),
        ),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1", diffTurnId: turnId };
        },
      });
    },
    [navigate, routeThreadRef],
  );
  const selectWholeConversation = useCallback(() => {
    if (!routeThreadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(routeThreadRef.environmentId, routeThreadRef.threadId),
      ),
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  }, [navigate, routeThreadRef]);

  return (
    <DiffPanelShell
      mode={mode}
      header={
        <DiffPanelHeader
          diffRenderMode={diffRenderMode}
          diffWordWrap={diffWordWrap}
          inferredCheckpointTurnCountByTurnId={inferredCheckpointTurnCountByTurnId}
          onDiffRenderModeChange={setDiffRenderMode}
          onDiffWordWrapChange={setDiffWordWrap}
          onSelectTurn={selectTurn}
          onSelectWholeConversation={selectWholeConversation}
          orderedTurnDiffSummaries={orderedTurnDiffSummaries}
          selectedTurnId={selectedTurnId}
          timestampFormat={settings.timestampFormat}
        />
      }
    >
      <DiffPanelContent
        activeThreadId={activeThreadId}
        diffRenderMode={diffRenderMode}
        diffWordWrap={diffWordWrap}
        orderedTurnDiffSummaries={orderedTurnDiffSummaries}
        selectedFilePath={selectedFilePath}
        selectedTurnId={selectedTurnId}
        workspaceSnapshot={workspaceSnapshot}
      />
    </DiffPanelShell>
  );
}
