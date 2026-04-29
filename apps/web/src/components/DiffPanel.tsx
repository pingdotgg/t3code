import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeThreadRef } from "@forma/client-runtime";
import type { TurnId } from "@forma/contracts";
import {
  IconChevronLeft as ChevronLeftIcon,
  IconChevronRight as ChevronRightIcon,
  IconRectangleSplit2x1 as Columns2Icon,
  IconRectangleSplit3x1 as Rows3Icon,
  IconTextWordSpacing as TextWrapIcon,
} from "symbols-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { useComposerHandleContext } from "../composerHandleContext";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { invalidateProjectQueries } from "~/lib/projectReactQuery";
import { type CodeContextSelection } from "~/lib/codeContext";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { resolvePathLinkTarget } from "../terminal-links";
import {
  buildDiffClosedSearch,
  buildDiffEditorSearch,
  buildDiffOpenSearch,
  buildDiffTurnSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "../lib/diffRendering";
import {
  buildDiffFileEditOverrideKey,
  buildDiffFileEditThreadKey,
  buildOverriddenFileDiff,
  readPersistedDiffFileEditOverrides,
  writePersistedDiffFileEditOverrides,
  type PersistedDiffFileEditOverride,
} from "../lib/diffFileEditOverrides";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffFileEditorPane } from "./DiffFileEditorPane";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

type DiffRenderMode = "stacked" | "split";
type DiffViewMode = "diff" | "editor";
type DiffThemeType = "light" | "dark";

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: var(--diff-surface-bg) !important;
  --diffs-light-bg: var(--diff-surface-bg) !important;
  --diffs-dark-bg: var(--diff-surface-bg) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: var(--diff-surface-context-bg);
  --diffs-bg-hover-override: var(--diff-surface-hover-bg);
  --diffs-bg-separator-override: var(--diff-surface-separator-bg);
  --diffs-bg-buffer-override: var(--diff-surface-buffer-bg);

  --diffs-bg-addition-override: var(--diff-surface-addition-bg);
  --diffs-bg-addition-number-override: var(--diff-surface-addition-number-bg);
  --diffs-bg-addition-hover-override: var(--diff-surface-addition-hover-bg);
  --diffs-bg-addition-emphasis-override: var(--diff-surface-addition-emphasis-bg);

  --diffs-bg-deletion-override: var(--diff-surface-deletion-bg);
  --diffs-bg-deletion-number-override: var(--diff-surface-deletion-number-bg);
  --diffs-bg-deletion-hover-override: var(--diff-surface-deletion-hover-bg);
  --diffs-bg-deletion-emphasis-override: var(--diff-surface-deletion-emphasis-bg);

  background-color: var(--diffs-bg) !important;
}

[data-diff],
[data-diff] *,
[data-file],
[data-file] * {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace) !important;
  font-size: var(--app-code-font-size) !important;
}

[data-file-info] {
  background-color: var(--diff-surface-elevated-bg) !important;
  border-block-color: var(--diff-surface-border) !important;
  color: var(--diff-surface-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: var(--diff-surface-elevated-bg) !important;
  border-bottom: 1px solid var(--diff-surface-border) !important;
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
  color: var(--diff-surface-title-hover) !important;
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

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const composerRef = useComposerHandleContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadStorageKey = buildDiffFileEditThreadKey(
    routeThreadRef?.environmentId ?? null,
    routeThreadRef?.threadId ?? null,
  );
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [savedOverridesByKey, setSavedOverridesByKey] = useState<
    Record<string, PersistedDiffFileEditOverride | undefined>
  >(() => readPersistedDiffFileEditOverrides(activeThreadStorageKey));
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const turnStripRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const [canScrollTurnStripLeft, setCanScrollTurnStripLeft] = useState(false);
  const [canScrollTurnStripRight, setCanScrollTurnStripRight] = useState(false);
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
  const editorFilePath = diffSearch.editorFilePath ?? null;
  const editorLine = diffSearch.editorLine;
  const editorColumn = diffSearch.editorColumn;
  const editorBackToDiff = diffSearch.editorBackToDiff === "1";
  const viewMode: DiffViewMode =
    diffSearch.diffView === "editor" && editorFilePath !== null ? "editor" : "diff";
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
      environmentId: activeThread?.environmentId ?? null,
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
  const renderableFileDiffsByPath = useMemo(
    () =>
      new Map(
        renderableFiles.map((fileDiff) => [resolveFileDiffPath(fileDiff), fileDiff] as const),
      ),
    [renderableFiles],
  );
  const selectedTurnFilePaths = useMemo(
    () =>
      selectedTurn
        ? [...new Set(selectedTurn.files.map((file) => file.path))].toSorted((left, right) =>
            left.localeCompare(right, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          )
        : [],
    [selectedTurn],
  );
  const selectedTurnFilePathSet = useMemo(
    () => new Set(selectedTurnFilePaths),
    [selectedTurnFilePaths],
  );
  const canEditFiles = Boolean(activeThread && activeCwd);
  const isSelectedTurnEditorFile =
    editorFilePath !== null &&
    selectedTurn !== undefined &&
    selectedTurnFilePathSet.has(editorFilePath);
  const editorFilePaths = useMemo(() => {
    if (!editorFilePath) {
      return [];
    }
    return isSelectedTurnEditorFile ? selectedTurnFilePaths : [editorFilePath];
  }, [editorFilePath, isSelectedTurnEditorFile, selectedTurnFilePaths]);
  const editorFileDiff =
    editorFilePath !== null ? (renderableFileDiffsByPath.get(editorFilePath) ?? null) : null;
  const editorOverrideKey =
    selectedTurn && editorFilePath && isSelectedTurnEditorFile
      ? buildDiffFileEditOverrideKey(selectedTurn.turnId, editorFilePath)
      : null;
  const editorOverride =
    editorOverrideKey !== null ? savedOverridesByKey[editorOverrideKey] : undefined;

  const updateSavedOverrides = useCallback(
    (
      nextState:
        | Record<string, PersistedDiffFileEditOverride | undefined>
        | ((
            current: Record<string, PersistedDiffFileEditOverride | undefined>,
          ) => Record<string, PersistedDiffFileEditOverride | undefined>),
    ) => {
      setSavedOverridesByKey((current) => {
        const resolved = typeof nextState === "function" ? nextState(current) : nextState;
        writePersistedDiffFileEditOverrides(activeThreadStorageKey, resolved);
        return resolved;
      });
    },
    [activeThreadStorageKey],
  );

  useEffect(() => {
    setSavedOverridesByKey(readPersistedDiffFileEditOverrides(activeThreadStorageKey));
  }, [activeThreadStorageKey]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current || viewMode !== "diff") {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles, viewMode]);

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

  const persistSavedDiffOverride = useCallback(
    async (input: { filePath: string; savedContents: string; preTurnContents: string | null }) => {
      if (!activeThread || !activeCwd) {
        return;
      }

      const affectsSelectedTurnDiff =
        selectedTurn !== undefined && selectedTurnFilePathSet.has(input.filePath);
      if (affectsSelectedTurnDiff) {
        const overrideKey = buildDiffFileEditOverrideKey(selectedTurn.turnId, input.filePath);
        updateSavedOverrides((current) => {
          const next = { ...current };
          if (input.preTurnContents === null) {
            delete next[overrideKey];
          } else {
            next[overrideKey] = {
              preTurnContents: input.preTurnContents,
              savedContents: input.savedContents,
            };
          }
          return next;
        });
      }

      await refreshGitStatus({
        environmentId: activeThread.environmentId,
        cwd: activeCwd,
      }).catch(() => undefined);
      await invalidateProjectQueries(queryClient, {
        environmentId: activeThread.environmentId,
        cwd: activeCwd,
      });
      if (affectsSelectedTurnDiff) {
        await activeCheckpointDiffQuery.refetch().catch(() => undefined);
      }
    },
    [
      activeCheckpointDiffQuery,
      activeCwd,
      activeThread,
      queryClient,
      selectedTurn,
      selectedTurnFilePathSet,
      updateSavedOverrides,
    ],
  );

  const addEditorCodeContext = useCallback(
    (selection: CodeContextSelection) => {
      const composerHandle = composerRef?.current;
      if (!composerHandle) {
        toastManager.add({
          type: "error",
          title: "Composer is unavailable",
        });
        return;
      }

      const added = composerHandle.addCodeContext(selection, {
        focusComposerAfterInsert: false,
      });
      toastManager.add({
        type: added ? "success" : "info",
        title: added ? "Code added to composer" : "Code already attached",
      });
    },
    [composerRef],
  );

  const openEditorForFile = useCallback(
    (filePath: string) => {
      if (!canEditFiles || !selectedTurn || !selectedTurnFilePathSet.has(filePath)) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(activeThread!.environmentId, activeThread!.id),
        ),
        search: (previous) =>
          buildDiffEditorSearch(previous, {
            filePath,
            turnId: selectedTurn.turnId,
            diffFilePath: filePath,
            backToDiff: true,
          }),
      });
    },
    [activeThread, canEditFiles, navigate, selectedTurn, selectedTurnFilePathSet],
  );

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => buildDiffTurnSearch(previous, { turnId }),
    });
  };

  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      search: (previous) => buildDiffOpenSearch(previous),
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

  const onTurnStripWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
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

  const diffHeaderRow = (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors [&_svg]:fill-current",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-2.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors [&_svg]:fill-current",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-2.5" />
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
              <div className="text-ui-2xs leading-tight font-medium">All turns</div>
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
                  <span className="text-ui-2xs leading-tight font-medium">
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
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
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
            <Rows3Icon className="size-3 fill-current" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3 fill-current" />
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
          <TextWrapIcon className="size-3 fill-current" />
        </Toggle>
      </div>
    </>
  );

  const headerRow = viewMode === "editor" ? undefined : diffHeaderRow;

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : viewMode === "editor" && activeCwd && editorFilePath ? (
        <DiffFileEditorPane
          cwd={activeCwd}
          environmentId={activeThread.environmentId}
          fileDiff={isSelectedTurnEditorFile ? editorFileDiff : null}
          filePath={editorFilePath}
          filePaths={editorFilePaths}
          initialColumn={editorColumn}
          initialLine={editorLine}
          initialOverride={editorOverride}
          navigationLabel="Exit edit"
          resolvedTheme={resolvedTheme}
          onAddCodeContext={addEditorCodeContext}
          onOpenInEditor={openDiffFileInEditor}
          onPersisted={persistSavedDiffOverride}
          onRequestBack={() => {
            if (editorBackToDiff && selectedTurn) {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(activeThread.environmentId, activeThread.id),
                ),
                search: (previous) =>
                  buildDiffTurnSearch(previous, {
                    turnId: selectedTurn.turnId,
                    filePath: selectedFilePath ?? undefined,
                  }),
              });
              return;
            }
            if (editorBackToDiff) {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(activeThread.environmentId, activeThread.id),
                ),
                search: (previous) => buildDiffOpenSearch(previous),
              });
              return;
            }
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(activeThread.environmentId, activeThread.id),
              ),
              search: (previous) => buildDiffClosedSearch(previous),
            });
          }}
          onRequestFilePathChange={(filePath) => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(activeThread.environmentId, activeThread.id),
              ),
              search: (previous) =>
                buildDiffEditorSearch(previous, {
                  filePath,
                  turnId: selectedTurn?.turnId,
                  diffFilePath: selectedTurn ? filePath : undefined,
                  backToDiff: editorBackToDiff,
                }),
            });
          }}
        />
      ) : viewMode === "editor" ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Workspace editor is unavailable for this thread.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <div
          ref={patchViewportRef}
          className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {checkpointDiffError && !renderablePatch && (
            <div className="px-3">
              <p className="text-ui-xs mb-2 text-red-500/80">{checkpointDiffError}</p>
            </div>
          )}
          {!renderablePatch ? (
            isLoadingCheckpointDiff ? (
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
                const overrideKey =
                  selectedTurn !== undefined
                    ? buildDiffFileEditOverrideKey(selectedTurn.turnId, filePath)
                    : null;
                const override =
                  overrideKey !== null ? savedOverridesByKey[overrideKey] : undefined;
                const displayFileDiff =
                  override !== undefined
                    ? (buildOverriddenFileDiff(filePath, override) ?? fileDiff)
                    : fileDiff;
                const canEditFile = canEditFiles && selectedTurnFilePathSet.has(filePath);

                return (
                  <div
                    key={themedFileKey}
                    data-diff-file-path={filePath}
                    className={cn(
                      "diff-render-file mb-2 overflow-hidden rounded-md border bg-card/70 first:mt-2 last:mb-0",
                      selectedFilePath === filePath ? "border-border" : "border-border/70",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="text-code-compact truncate font-mono text-foreground underline decoration-transparent underline-offset-2 transition-colors hover:text-primary hover:decoration-current"
                          onClick={() => openDiffFileInEditor(filePath)}
                          title={filePath}
                        >
                          {filePath}
                        </button>
                        {override ? (
                          <p className="text-ui-2xs text-muted-foreground/65">
                            Showing saved manual edits
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {canEditFile ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openEditorForFile(filePath)}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <FileDiff
                      fileDiff={displayFileDiff}
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
                );
              })}
            </Virtualizer>
          ) : (
            <div className="h-full overflow-auto p-2">
              <div className="space-y-2">
                <p className="text-ui-xs text-muted-foreground/75">{renderablePatch.reason}</p>
                <pre
                  className={cn(
                    "text-code-body max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono leading-relaxed text-muted-foreground/90",
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
      )}
    </DiffPanelShell>
  );
}
