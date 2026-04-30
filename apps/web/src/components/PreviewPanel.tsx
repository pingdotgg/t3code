import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { Schema } from "effect";
import { CircleAlertIcon, RefreshCwIcon, TextWrapIcon, TriangleAlertIcon } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { parsePreviewRouteSearch } from "../previewRouteSearch";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteRef } from "../threadRoutes";
import { ChangedFilesTree } from "./chat/ChangedFilesTree";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Toggle } from "./ui/toggle";
import { cn } from "~/lib/utils";

const PREVIEW_TREE_WIDTH_STORAGE_KEY = "chat_preview_tree_width";
const PREVIEW_TREE_MIN_WIDTH = 220;
const PREVIEW_TREE_DEFAULT_WIDTH = 280;
const PREVIEW_TREE_MAX_RATIO = 0.55;
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const PREVIEW_CODE_CSS = `
.preview-panel-shiki {
  background-color: color-mix(in srgb, var(--card) 90%, var(--background));
  --preview-line-number-width: 2rem;
  --preview-line-number-gap: 0.75rem;
}

.preview-panel-shiki pre {
  margin: 0;
  line-height: 0;
}

.preview-panel-shiki pre,
.preview-panel-shiki code {
  background: transparent !important;
}

.preview-panel-shiki code {
  counter-reset: preview-line;
  display: grid;
  font-size: 11px;
}

.preview-panel-shiki .line {
  display: block;
  line-height: 1.25rem;
  padding-left: calc(var(--preview-line-number-width) + var(--preview-line-number-gap));
  text-indent: calc(-1 * (var(--preview-line-number-width) + var(--preview-line-number-gap)));
}

.preview-panel-shiki .line::before {
  counter-increment: preview-line;
  content: counter(preview-line);
  display: inline-block;
  width: var(--preview-line-number-width);
  margin-right: var(--preview-line-number-gap);
  color: color-mix(in srgb, var(--muted-foreground) 85%, transparent);
  text-align: right;
  text-indent: 0;
  user-select: none;
}

.preview-panel-shiki.preview-wrap .line {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
`;

function extensionToLanguage(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  const basename = lowerPath.split("/").at(-1) ?? lowerPath;
  if (basename === "dockerfile") return "dockerfile";
  if (basename === ".gitignore") return "ini";
  if (basename.endsWith(".md")) return "markdown";
  if (basename.endsWith(".tsx")) return "tsx";
  if (basename.endsWith(".ts")) return "ts";
  if (basename.endsWith(".jsx")) return "jsx";
  if (basename.endsWith(".js")) return "js";
  if (basename.endsWith(".json")) return "json";
  if (basename.endsWith(".css")) return "css";
  if (basename.endsWith(".html")) return "html";
  if (basename.endsWith(".yml") || basename.endsWith(".yaml")) return "yaml";
  if (basename.endsWith(".sh")) return "bash";
  if (basename.endsWith(".py")) return "python";
  if (basename.endsWith(".rs")) return "rust";
  if (basename.endsWith(".go")) return "go";
  return "text";
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      throw err;
    }
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function clampTreeWidth(width: number, containerWidth: number): number {
  const maxWidth = Math.max(
    PREVIEW_TREE_MIN_WIDTH,
    Math.floor(containerWidth * PREVIEW_TREE_MAX_RATIO),
  );
  return Math.max(PREVIEW_TREE_MIN_WIDTH, Math.min(width, maxWidth));
}

function getResizedTreeWidth(
  resizeState: { startWidth: number; startX: number },
  containerWidth: number,
  pointerClientX: number,
): number {
  const delta = pointerClientX - resizeState.startX;
  return clampTreeWidth(resizeState.startWidth + delta, containerWidth);
}

function isMissingWorkspaceFileError(message: string | null): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("enoent") ||
    normalized.includes("no such file") ||
    normalized.includes("file not found") ||
    normalized.includes("cannot find the file")
  );
}

interface PreviewPanelProps {
  mode?: DiffPanelMode;
}

export default function PreviewPanel({ mode = "inline" }: PreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const previewSearch = useSearch({
    strict: false,
    select: (search) => parsePreviewRouteSearch(search),
  });
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
  const activeCwd = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [wrapPreviewLines, setWrapPreviewLines] = useState(settings.diffWordWrap);
  const [highlightedPreviewHtml, setHighlightedPreviewHtml] = useState<string | null>(null);
  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const [treeWidth, setTreeWidth] = useState(() => {
    if (typeof window === "undefined") {
      return PREVIEW_TREE_DEFAULT_WIDTH;
    }
    return (
      getLocalStorageItem(PREVIEW_TREE_WIDTH_STORAGE_KEY, Schema.Finite) ??
      PREVIEW_TREE_DEFAULT_WIDTH
    );
  });
  const resizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const previousPreviewOpenRef = useRef(previewSearch.preview === "1");
  const previousProjectFilesRefreshKeyRef = useRef<string | null>(null);
  const previousSelectedFileRefreshKeyRef = useRef<string | null>(null);
  const missingFileRefreshKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setWrapPreviewLines(settings.diffWordWrap);
  }, [settings.diffWordWrap]);

  useEffect(() => {
    setSelectedFilePath(null);
  }, [activeThread?.environmentId, activeThread?.id]);

  const latestProjectFilesRefreshKey = useMemo(() => {
    const latestChangedSummary = (activeThread?.turnDiffSummaries ?? [])
      .toReversed()
      .find((summary) => summary.files.length > 0);
    return latestChangedSummary
      ? `${latestChangedSummary.turnId}:${latestChangedSummary.completedAt}`
      : null;
  }, [activeThread?.turnDiffSummaries]);

  const latestSelectedFileRefreshKey = useMemo(() => {
    if (!selectedFilePath) return null;
    const latestSelectedFileSummary = (activeThread?.turnDiffSummaries ?? [])
      .toReversed()
      .find((summary) => summary.files.some((file) => file.path === selectedFilePath));
    return latestSelectedFileSummary
      ? `${latestSelectedFileSummary.turnId}:${latestSelectedFileSummary.completedAt}`
      : null;
  }, [activeThread?.turnDiffSummaries, selectedFilePath]);

  const projectFilesQuery = useQuery({
    queryKey: ["projects", "listEntries", activeThread?.environmentId ?? null, activeCwd],
    queryFn: async () => {
      if (!activeThread?.environmentId || !activeCwd) {
        throw new Error("Project tree is unavailable.");
      }
      const api = ensureEnvironmentApi(activeThread.environmentId);
      return api.projects.listEntries({ cwd: activeCwd });
    },
    enabled: Boolean(activeThread?.environmentId && activeCwd && previewSearch.preview === "1"),
    retry: 1,
    select: (result) => ({
      ...result,
      entries: result.entries.toSorted((left, right) =>
        left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
      ),
    }),
  });
  const projectFilesError =
    projectFilesQuery.error instanceof Error
      ? projectFilesQuery.error.message
      : projectFilesQuery.error
        ? "Failed to load the workspace tree."
        : null;
  const projectFiles = projectFilesQuery.data;
  const projectFilesTruncated = projectFilesQuery.data?.truncated === true;
  const projectFilesIsFetching = projectFilesQuery.isFetching;
  const refetchProjectFiles = projectFilesQuery.refetch;

  useEffect(() => {
    if (!projectFiles) {
      return;
    }
    if (projectFiles.entries.length === 0) {
      setSelectedFilePath(null);
      return;
    }
    if (selectedFilePath && !projectFiles.entries.some((file) => file.path === selectedFilePath)) {
      setSelectedFilePath(null);
    }
  }, [projectFiles, selectedFilePath]);

  useEffect(() => {
    if (previewSearch.preview !== "1") {
      previousProjectFilesRefreshKeyRef.current = latestProjectFilesRefreshKey;
      return;
    }
    if (previousProjectFilesRefreshKeyRef.current === null) {
      previousProjectFilesRefreshKeyRef.current = latestProjectFilesRefreshKey;
      return;
    }
    if (previousProjectFilesRefreshKeyRef.current === latestProjectFilesRefreshKey) {
      return;
    }
    previousProjectFilesRefreshKeyRef.current = latestProjectFilesRefreshKey;
    void refetchProjectFiles();
  }, [latestProjectFilesRefreshKey, previewSearch.preview, refetchProjectFiles]);

  useEffect(() => {
    const previewOpen = previewSearch.preview === "1";
    if (previewOpen && !previousPreviewOpenRef.current) {
      setSelectedFilePath(null);
    }
    previousPreviewOpenRef.current = previewOpen;
  }, [previewSearch.preview]);

  const selectedFileQuery = useQuery({
    queryKey: [
      "projects",
      "readFile",
      activeThread?.environmentId ?? null,
      activeCwd,
      selectedFilePath,
    ],
    queryFn: async () => {
      if (!activeThread?.environmentId || !activeCwd || !selectedFilePath) {
        throw new Error("File preview is unavailable.");
      }
      const api = ensureEnvironmentApi(activeThread.environmentId);
      return api.projects.readFile({
        cwd: activeCwd,
        relativePath: selectedFilePath,
      });
    },
    enabled: Boolean(
      activeThread?.environmentId && activeCwd && selectedFilePath && previewSearch.preview === "1",
    ),
    retry: 1,
  });
  const selectedFileData =
    selectedFileQuery.data?.relativePath === selectedFilePath ? selectedFileQuery.data : null;
  const selectedFileError =
    selectedFileQuery.error instanceof Error
      ? selectedFileQuery.error.message
      : selectedFileQuery.error
        ? "Failed to load file preview."
        : null;
  const refetchSelectedFile = selectedFileQuery.refetch;

  useEffect(() => {
    if (!selectedFilePath || previewSearch.preview !== "1") {
      previousSelectedFileRefreshKeyRef.current = latestSelectedFileRefreshKey;
      return;
    }
    if (previousSelectedFileRefreshKeyRef.current === null) {
      previousSelectedFileRefreshKeyRef.current = latestSelectedFileRefreshKey;
      return;
    }
    if (previousSelectedFileRefreshKeyRef.current === latestSelectedFileRefreshKey) {
      return;
    }
    previousSelectedFileRefreshKeyRef.current = latestSelectedFileRefreshKey;
    void refetchSelectedFile();
  }, [latestSelectedFileRefreshKey, previewSearch.preview, refetchSelectedFile, selectedFilePath]);

  useEffect(() => {
    if (!selectedFilePath || !isMissingWorkspaceFileError(selectedFileError)) {
      missingFileRefreshKeyRef.current = null;
      return;
    }
    const refreshKey = `${activeCwd ?? ""}\u0000${selectedFilePath}\u0000${selectedFileError}`;
    if (missingFileRefreshKeyRef.current === refreshKey) {
      return;
    }
    missingFileRefreshKeyRef.current = refreshKey;
    void refetchProjectFiles()
      .then((result) => {
        if (!result.data?.entries.some((entry) => entry.path === selectedFilePath)) {
          setSelectedFilePath((current) => (current === selectedFilePath ? null : current));
        }
      })
      .catch(() => undefined);
  }, [activeCwd, refetchProjectFiles, selectedFileError, selectedFilePath]);

  useEffect(() => {
    let cancelled = false;
    const contents = selectedFileData?.contents ?? "";
    if (!selectedFilePath || contents.length === 0) {
      setHighlightedPreviewHtml(null);
      return;
    }

    const language = extensionToLanguage(selectedFilePath);
    getHighlighterPromise(language)
      .then((highlighter) => {
        const html = highlighter.codeToHtml(contents, {
          lang: language,
          theme: resolveDiffThemeName(resolvedTheme),
        });
        if (!cancelled) {
          setHighlightedPreviewHtml(html);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedPreviewHtml(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedTheme, selectedFileData?.contents, selectedFilePath]);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startWidth: treeWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "e-resize";
      document.body.style.userSelect = "none";
    },
    [treeWidth],
  );

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    const container = splitLayoutRef.current;
    if (!resizeState || !container || resizeState.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const nextWidth = getResizedTreeWidth(resizeState, container.clientWidth, event.clientX);
    setTreeWidth(nextWidth);
  }, []);

  const onResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;
    const container = splitLayoutRef.current;
    if (!resizeState || !container || resizeState.pointerId !== event.pointerId) {
      return;
    }
    const nextWidth = getResizedTreeWidth(resizeState, container.clientWidth, event.clientX);
    resizeStateRef.current = null;
    setTreeWidth(nextWidth);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (typeof window !== "undefined") {
      setLocalStorageItem(PREVIEW_TREE_WIDTH_STORAGE_KEY, nextWidth, Schema.Finite);
    }
  }, []);

  useEffect(
    () => () => {
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );

  const onRefreshProjectFiles = useCallback(() => {
    void refetchProjectFiles();
  }, [refetchProjectFiles]);

  const headerRow = (
    <>
      <div className="min-w-0 flex-1 px-1 [-webkit-app-region:no-drag]">
        <div className="truncate text-sm font-medium text-foreground">File Preview</div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Workspace tree</span>
          {projectFilesTruncated ? (
            <Badge variant="warning" size="sm" className="rounded-md px-1.5 py-0 text-[9px]">
              Truncated
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          aria-label="Refresh workspace tree"
          title="Refresh workspace tree"
          variant="outline"
          size="icon-xs"
          className="shrink-0"
          disabled={!activeThread?.environmentId || !activeCwd || projectFilesIsFetching}
          onClick={onRefreshProjectFiles}
        >
          <RefreshCwIcon className={cn("size-3", projectFilesIsFetching && "animate-spin")} />
        </Button>
        <Toggle
          aria-label={
            wrapPreviewLines ? "Disable preview line wrapping" : "Enable preview line wrapping"
          }
          title={wrapPreviewLines ? "Disable line wrapping" : "Enable line wrapping"}
          variant="outline"
          size="xs"
          pressed={wrapPreviewLines}
          onPressedChange={(pressed) => {
            setWrapPreviewLines(Boolean(pressed));
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
          Select a thread to preview files.
        </div>
      ) : projectFilesQuery.isLoading && !projectFilesQuery.data ? (
        <DiffPanelLoadingState label="Loading project tree..." />
      ) : projectFilesError && !projectFilesQuery.data ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          {projectFilesError}
        </div>
      ) : (projectFilesQuery.data?.entries.length ?? 0) === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No project files available yet.
        </div>
      ) : (
        <div ref={splitLayoutRef} className="flex min-h-0 min-w-0 flex-1">
          <div
            className="min-h-0 shrink-0 overflow-auto bg-card/20 p-2"
            style={{ width: `${treeWidth}px`, maxWidth: "55%" } satisfies CSSProperties}
          >
            {projectFilesError || projectFilesTruncated ? (
              <Alert
                variant={projectFilesError ? "error" : "warning"}
                className="mb-2 rounded-lg border-border/70 px-3 py-2 text-[11px]"
              >
                {projectFilesError ? (
                  <CircleAlertIcon className="size-3.5" />
                ) : (
                  <TriangleAlertIcon className="size-3.5" />
                )}
                <AlertTitle className="text-[11px]">
                  {projectFilesError
                    ? "Workspace tree refresh failed"
                    : "Workspace tree is truncated"}
                </AlertTitle>
                <AlertDescription className="gap-1 text-[11px] leading-4">
                  {projectFilesError ? (
                    <span>{projectFilesError}</span>
                  ) : (
                    <span>
                      Only the first indexed workspace entries are shown here, so some files may be
                      omitted from preview.
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            ) : null}
            <ChangedFilesTree
              files={projectFilesQuery.data?.entries ?? []}
              allDirectoriesExpanded={false}
              resolvedTheme={resolvedTheme}
              onSelectFile={setSelectedFilePath}
              selectedFilePath={selectedFilePath}
              showStats={false}
            />
          </div>
          <button
            type="button"
            aria-label="Resize file preview tree"
            className="group relative w-2 shrink-0 cursor-e-resize bg-background transition-colors hover:bg-accent/40"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerEnd}
            onPointerCancel={onResizePointerEnd}
          >
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/80 group-hover:bg-border" />
          </button>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!selectedFilePath ? (
              <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
                Select a file to preview.
              </div>
            ) : selectedFileQuery.isLoading && !selectedFileData ? (
              <DiffPanelLoadingState label="Loading file preview..." />
            ) : selectedFileError ? (
              <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
                {selectedFileError}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <style>{PREVIEW_CODE_CSS}</style>
                <div className="min-h-full overflow-hidden rounded-md border border-border/70 bg-[color:color-mix(in_srgb,var(--card)_90%,var(--background))]">
                  <div className="border-b border-border/70 bg-[color:color-mix(in_srgb,var(--card)_94%,var(--foreground))] px-3 py-2 text-foreground">
                    <div className="truncate font-mono text-[12px] font-medium">
                      {selectedFilePath}
                    </div>
                  </div>
                  {highlightedPreviewHtml ? (
                    <div
                      className={cn(
                        "preview-panel-shiki min-h-full p-3",
                        wrapPreviewLines && "preview-wrap",
                      )}
                      dangerouslySetInnerHTML={{ __html: highlightedPreviewHtml }}
                    />
                  ) : (
                    <pre
                      className={cn(
                        "min-h-full bg-transparent p-3 font-mono text-[11px] leading-5 text-muted-foreground/90",
                        wrapPreviewLines
                          ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                          : "overflow-auto",
                      )}
                    >
                      {selectedFileData?.contents ?? ""}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
