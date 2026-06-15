import { prepareFileTreeInput, type GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import type { ProjectEntry, ScopedThreadRef } from "@t3tools/contracts";
import { CircleAlertIcon, ListFilterIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTheme } from "../hooks/useTheme";
import { useVcsStatus } from "../lib/vcsStatusState";
import { cn } from "../lib/utils";
import { selectProjectByRef, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Toggle } from "./ui/toggle";

const FILE_PREVIEW_TREE_DEFAULT_WIDTH = 280;
const FILE_PREVIEW_TREE_MIN_WIDTH = 220;
const FILE_PREVIEW_TREE_MAX_WIDTH_RATIO = 0.55;
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const FILE_PREVIEW_TREE_UNSAFE_CSS = `
:host {
  --trees-bg-override: transparent;
  --trees-bg-muted-override: color-mix(in srgb, var(--accent) 10%, transparent);
  --trees-border-color-override: var(--input);
  --trees-focus-ring-color-override: transparent;
  --trees-search-bg-override: var(--popover);
  --trees-search-fg-override: var(--foreground);
  --truncate-marker-background-color: transparent;
}

[data-file-tree-virtualized-wrapper='true'],
[data-file-tree-virtualized-root='true'],
[data-file-tree-virtualized-scroll='true'] {
  background: transparent;
}

[data-file-tree-search-container][data-open='false'] {
  display: none;
}

[data-file-tree-search-container] {
  padding-inline: 0;
  margin-bottom: 0.5rem;
}

[data-file-tree-search-input] {
  height: 2rem;
  border-radius: var(--radius-lg);
  outline: none;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--foreground) 5%, transparent);
}

[data-file-tree-search-input]:focus,
[data-file-tree-search-input]:focus-visible {
  border-color: var(--input);
  outline: none;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--foreground) 5%, transparent);
}

button[data-type='item']:focus,
button[data-type='item']:focus-visible {
  outline: none;
  box-shadow: none;
}
`;
const FILE_PREVIEW_CODE_CSS = `
.file-preview-shiki {
  background-color: color-mix(in srgb, var(--card) 90%, var(--background));
  --file-preview-line-number-width: 2rem;
  --file-preview-line-number-gap: 0.75rem;
}

.file-preview-shiki pre {
  margin: 0;
  line-height: 0;
}

.file-preview-shiki pre,
.file-preview-shiki code {
  background: transparent !important;
}

.file-preview-shiki code {
  counter-reset: file-preview-line;
  display: grid;
  font-size: 11px;
}

.file-preview-shiki .line {
  display: block;
  line-height: 1.25rem;
  padding-left: calc(var(--file-preview-line-number-width) + var(--file-preview-line-number-gap));
  text-indent: calc(-1 * (var(--file-preview-line-number-width) + var(--file-preview-line-number-gap)));
}

.file-preview-shiki .line::before {
  counter-increment: file-preview-line;
  content: counter(file-preview-line);
  display: inline-block;
  width: var(--file-preview-line-number-width);
  margin-right: var(--file-preview-line-number-gap);
  color: color-mix(in srgb, var(--muted-foreground) 85%, transparent);
  text-align: right;
  text-indent: 0;
  user-select: none;
}

`;

function clampTreeWidth(width: number, maxWidth: number): number {
  return Math.min(Math.max(width, FILE_PREVIEW_TREE_MIN_WIDTH), maxWidth);
}

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

function toFileTreePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path.replace(/\/+$/, "")}/` : entry.path;
}

function fromFileTreePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function ancestorDirectoryPaths(filePath: string): string[] {
  const segments = filePath.split("/").filter((segment) => segment.length > 0);
  const paths: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    paths.push(`${segments.slice(0, index).join("/")}/`);
  }
  return paths;
}

function parentPathOf(path: string): string | undefined {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : path.slice(0, separatorIndex);
}

function toGitStatusEntries(
  files: ReadonlyArray<{
    readonly path: string;
    readonly status?: GitStatusEntry["status"] | undefined;
  }>,
): ReadonlyArray<GitStatusEntry> {
  return files.map((file) => ({ path: file.path, status: file.status ?? "modified" }));
}

function filterChangedProjectEntries(
  entries: ReadonlyArray<ProjectEntry>,
  changedFilePaths: ReadonlySet<string>,
): ReadonlyArray<ProjectEntry> {
  if (changedFilePaths.size === 0) {
    return [];
  }

  const directoryPaths = new Set<string>();
  for (const filePath of changedFilePaths) {
    for (const directoryPath of ancestorDirectoryPaths(filePath)) {
      directoryPaths.add(directoryPath.slice(0, -1));
    }
  }

  const seenPaths = new Set<string>();
  const filteredEntries = entries.filter((entry) => {
    const visible =
      entry.kind === "file" ? changedFilePaths.has(entry.path) : directoryPaths.has(entry.path);
    if (visible) {
      seenPaths.add(entry.path);
    }
    return visible;
  });

  for (const filePath of changedFilePaths) {
    for (const directoryPath of ancestorDirectoryPaths(filePath)) {
      const path = directoryPath.slice(0, -1);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      filteredEntries.push({
        path,
        kind: "directory",
        ...(parentPathOf(path) ? { parentPath: parentPathOf(path) } : {}),
      });
    }
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    filteredEntries.push({
      path: filePath,
      kind: "file",
      ...(parentPathOf(filePath) ? { parentPath: parentPathOf(filePath) } : {}),
    });
  }

  return filteredEntries.toSorted((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function expandAncestors(model: ReturnType<typeof useFileTree>["model"], filePath: string): void {
  for (const path of ancestorDirectoryPaths(filePath)) {
    const item = model.getItem(path);
    if (item && "expand" in item) {
      item.expand();
    }
  }
}

interface FilePreviewTreeProps {
  entries: ReadonlyArray<ProjectEntry>;
  expandAll: boolean;
  gitStatus: ReadonlyArray<GitStatusEntry>;
  searchOpen: boolean;
  selectedFilePath: string | null;
  onSearchOpenChange: (open: boolean) => void;
  onSelectFile: (filePath: string | null) => void;
}

function FilePreviewTree({
  entries,
  expandAll,
  gitStatus,
  searchOpen,
  selectedFilePath,
  onSearchOpenChange,
  onSelectFile,
}: FilePreviewTreeProps) {
  const selectableFilePathsRef = useRef<ReadonlySet<string>>(new Set());
  const selectedFilePathRef = useRef(selectedFilePath);
  const treePaths = useMemo(() => entries.map(toFileTreePath), [entries]);
  const preparedInput = useMemo(() => prepareFileTreeInput(treePaths), [treePaths]);
  const selectableFilePaths = useMemo(
    () => new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path)),
    [entries],
  );
  const selectedFileExpandedPaths = useMemo(
    () => (selectedFilePath ? ancestorDirectoryPaths(selectedFilePath) : []),
    [selectedFilePath],
  );

  useEffect(() => {
    selectableFilePathsRef.current = selectableFilePaths;
  }, [selectableFilePaths]);

  useEffect(() => {
    selectedFilePathRef.current = selectedFilePath;
  }, [selectedFilePath]);

  const { model } = useFileTree({
    paths: treePaths,
    preparedInput,
    flattenEmptyDirectories: true,
    initialExpansion: expandAll ? "open" : "closed",
    initialExpandedPaths: expandAll ? [] : selectedFileExpandedPaths,
    density: "compact",
    gitStatus,
    search: true,
    searchFakeFocus: false,
    searchBlurBehavior: "retain",
    unsafeCSS: FILE_PREVIEW_TREE_UNSAFE_CSS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1);
      if (!selectedPath) {
        onSelectFile(null);
        return;
      }
      const filePath = fromFileTreePath(selectedPath);
      onSelectFile(selectableFilePathsRef.current.has(filePath) ? filePath : null);
    },
  });
  const searchState = useFileTreeSearch(model);
  const previousSearchOpenRef = useRef(searchOpen);

  useEffect(() => {
    const selectedPath = selectedFilePathRef.current;
    model.resetPaths(treePaths, {
      preparedInput,
      ...(expandAll
        ? {}
        : { initialExpandedPaths: selectedPath ? ancestorDirectoryPaths(selectedPath) : [] }),
    });
  }, [expandAll, model, preparedInput, treePaths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    if (previousSearchOpenRef.current === searchOpen) {
      return;
    }
    previousSearchOpenRef.current = searchOpen;
    if (searchOpen) {
      model.openSearch();
    } else {
      model.closeSearch();
    }
  }, [model, searchOpen]);

  useEffect(() => {
    if (searchState.isOpen !== searchOpen && searchState.isOpen === model.isSearchOpen()) {
      onSearchOpenChange(searchState.isOpen);
    }
  }, [model, onSearchOpenChange, searchOpen, searchState.isOpen]);

  useEffect(() => {
    const selectedTreePath = selectedFilePath ? selectedFilePath : null;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedTreePath) {
        model.getItem(path)?.deselect();
      }
    }
    if (selectedTreePath) {
      expandAncestors(model, selectedTreePath);
      model.getItem(selectedTreePath)?.select();
      model.scrollToPath(selectedTreePath, { focus: false, offset: "nearest" });
    }
  }, [model, selectedFilePath]);

  return (
    <FileTree model={model} className="h-full w-full" style={{ height: "100%" } as CSSProperties} />
  );
}

interface FilePreviewPanelProps {
  mode?: DiffPanelMode;
  threadRef: ScopedThreadRef;
  visible: boolean;
  initialFilePath?: string | undefined;
}

export default function FilePreviewPanel({
  mode = "embedded",
  threadRef,
  visible,
  initialFilePath,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const activeThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
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
  const gitStatusQuery = useVcsStatus({
    environmentId: activeThread?.environmentId ?? null,
    cwd: activeCwd,
  });
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(initialFilePath ?? null);
  const [treeSearchOpen, setTreeSearchOpen] = useState(false);
  const [showModifiedOnly, setShowModifiedOnly] = useState(false);
  const [treeWidth, setTreeWidth] = useState(FILE_PREVIEW_TREE_DEFAULT_WIDTH);
  const [highlightedPreviewHtml, setHighlightedPreviewHtml] = useState<string | null>(null);
  const previewLayoutRef = useRef<HTMLDivElement | null>(null);
  const previousVisibleRef = useRef(visible);
  const previousProjectFilesRefreshKeyRef = useRef<string | null>(null);
  const previousSelectedFileRefreshKeyRef = useRef<string | null>(null);
  const treeResizeStateRef = useRef<{
    readonly startX: number;
    readonly startWidth: number;
    readonly maxWidth: number;
    readonly previousCursor: string;
    readonly previousUserSelect: string;
  } | null>(null);

  useEffect(() => {
    const stopResize = () => {
      const state = treeResizeStateRef.current;
      if (!state) return;
      treeResizeStateRef.current = null;
      document.body.style.cursor = state.previousCursor;
      document.body.style.userSelect = state.previousUserSelect;
    };
    const handlePointerMove = (event: PointerEvent) => {
      const state = treeResizeStateRef.current;
      if (!state) return;
      const nextWidth = clampTreeWidth(
        state.startWidth + event.clientX - state.startX,
        state.maxWidth,
      );
      setTreeWidth(nextWidth);
    };
    const handlePointerUp = () => {
      stopResize();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      stopResize();
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  const maxTreeWidth = () =>
    Math.max(
      FILE_PREVIEW_TREE_MIN_WIDTH,
      Math.floor(
        (previewLayoutRef.current?.getBoundingClientRect().width ??
          FILE_PREVIEW_TREE_DEFAULT_WIDTH) * FILE_PREVIEW_TREE_MAX_WIDTH_RATIO,
      ),
    );

  useEffect(() => {
    setSelectedFilePath(initialFilePath ?? null);
  }, [activeThread?.environmentId, activeThread?.id, initialFilePath]);

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
    enabled: Boolean(activeThread?.environmentId && activeCwd && visible),
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
  const projectFilesTruncated = projectFilesQuery.data?.truncated === true;
  const refetchProjectFiles = projectFilesQuery.refetch;
  const gitStatusEntries = useMemo(
    () => toGitStatusEntries(gitStatusQuery.data?.workingTree.files ?? []),
    [gitStatusQuery.data?.workingTree.files],
  );
  const changedFilePaths = useMemo(
    () => new Set(gitStatusEntries.map((entry) => entry.path)),
    [gitStatusEntries],
  );
  const projectEntries = projectFilesQuery.data?.entries ?? [];
  const visibleProjectEntries = useMemo(
    () =>
      showModifiedOnly
        ? filterChangedProjectEntries(projectEntries, changedFilePaths)
        : projectEntries,
    [changedFilePaths, projectEntries, showModifiedOnly],
  );

  useEffect(() => {
    if (projectFilesQuery.data?.entries?.length === 0) {
      setSelectedFilePath(null);
      return;
    }
    if (
      selectedFilePath &&
      !changedFilePaths.has(selectedFilePath) &&
      !projectFilesQuery.data?.entries.some(
        (file) => file.kind === "file" && file.path === selectedFilePath,
      )
    ) {
      setSelectedFilePath(null);
    }
  }, [changedFilePaths, projectFilesQuery.data?.entries, selectedFilePath]);

  useEffect(() => {
    if (!visible) {
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
  }, [latestProjectFilesRefreshKey, refetchProjectFiles, visible]);

  useEffect(() => {
    if (visible && !previousVisibleRef.current) {
      setSelectedFilePath(null);
    }
    previousVisibleRef.current = visible;
  }, [visible]);

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
    enabled: Boolean(activeThread?.environmentId && activeCwd && selectedFilePath && visible),
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
    if (!selectedFilePath || !visible) {
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
  }, [latestSelectedFileRefreshKey, refetchSelectedFile, selectedFilePath, visible]);

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
        <Toggle
          aria-label={showModifiedOnly ? "Show all files" : "Show only changed files"}
          title={showModifiedOnly ? "Show all files" : "Show only changed files"}
          variant="outline"
          size="xs"
          pressed={showModifiedOnly}
          onPressedChange={(pressed) => {
            setShowModifiedOnly(Boolean(pressed));
          }}
        >
          <ListFilterIcon className="size-3" />
        </Toggle>
        <button
          type="button"
          aria-label={treeSearchOpen ? "Hide file search" : "Show file search"}
          title={treeSearchOpen ? "Hide file search" : "Show file search"}
          aria-pressed={treeSearchOpen}
          className={cn(
            "relative inline-flex size-6 shrink-0 cursor-pointer select-none items-center justify-center rounded-md border border-input bg-background text-foreground shadow-xs/5 outline-none transition-shadow hover:bg-accent dark:bg-input/32 dark:hover:bg-input/64 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            treeSearchOpen && "bg-input/64 text-accent-foreground shadow-none",
          )}
          onClick={() => {
            setTreeSearchOpen((open) => !open);
          }}
        >
          <SearchIcon className="size-3" />
        </button>
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
        <div ref={previewLayoutRef} className="flex min-h-0 min-w-0 flex-1">
          <div
            className="min-h-0 shrink-0 overflow-hidden bg-transparent p-2"
            style={
              {
                width: `${treeWidth}px`,
                maxWidth: "55%",
              } satisfies CSSProperties
            }
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
                  {projectFilesError ? "Workspace tree failed" : "Workspace tree is truncated"}
                </AlertTitle>
                <AlertDescription className="gap-1 text-[11px] leading-4">
                  {projectFilesError ? (
                    <span>{projectFilesError}</span>
                  ) : (
                    <span>Only the first indexed workspace entries are shown here.</span>
                  )}
                </AlertDescription>
              </Alert>
            ) : null}
            {visibleProjectEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
                No changed files.
              </div>
            ) : (
              <FilePreviewTree
                key={showModifiedOnly ? "changed-files" : "all-files"}
                entries={visibleProjectEntries}
                expandAll={showModifiedOnly}
                gitStatus={gitStatusEntries}
                searchOpen={treeSearchOpen}
                selectedFilePath={selectedFilePath}
                onSearchOpenChange={setTreeSearchOpen}
                onSelectFile={setSelectedFilePath}
              />
            )}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={FILE_PREVIEW_TREE_MIN_WIDTH}
            aria-valuemax={maxTreeWidth()}
            aria-valuenow={treeWidth}
            tabIndex={0}
            className="group relative w-1 shrink-0 cursor-col-resize bg-border/70 outline-none focus-visible:bg-ring/40"
            onPointerDown={(event) => {
              event.preventDefault();
              treeResizeStateRef.current = {
                startX: event.clientX,
                startWidth: treeWidth,
                maxWidth: maxTreeWidth(),
                previousCursor: document.body.style.cursor,
                previousUserSelect: document.body.style.userSelect,
              };
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setTreeWidth((width) =>
                clampTreeWidth(width + (event.key === "ArrowRight" ? 16 : -16), maxTreeWidth()),
              );
            }}
          />
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
                <style>{FILE_PREVIEW_CODE_CSS}</style>
                <div className="min-h-full overflow-hidden rounded-md border border-border/70 bg-[color:color-mix(in_srgb,var(--card)_90%,var(--background))]">
                  <div className="border-b border-border/70 bg-[color:color-mix(in_srgb,var(--card)_94%,var(--foreground))] px-3 py-2 text-foreground">
                    <div className="truncate font-mono text-[12px] font-medium">
                      {selectedFilePath}
                    </div>
                  </div>
                  {highlightedPreviewHtml ? (
                    <div
                      className="file-preview-shiki min-h-full p-3"
                      dangerouslySetInnerHTML={{ __html: highlightedPreviewHtml }}
                    />
                  ) : (
                    <pre className="min-h-full overflow-auto bg-transparent p-3 font-mono text-[11px] leading-5 text-muted-foreground/90">
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
