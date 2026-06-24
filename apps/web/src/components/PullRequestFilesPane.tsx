import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { EnvironmentId, PullRequestReviewComment } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  SearchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { gitPrEnvironment } from "~/state/gitPr";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { buildPatchCacheKey, resolveDiffThemeName } from "~/lib/diffRendering";
import { usePullRequestViewedFiles } from "~/lib/pullRequestViewedFiles";
import { cn } from "~/lib/utils";
import { PullRequestFileTree, fileLineCountsFromPatchFiles } from "./PullRequestFileTree";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Spinner } from "./ui/spinner";
import { Toggle } from "./ui/toggle";
import { ToggleGroup } from "./ui/toggle-group";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FileFilter = "all" | "unviewed" | "commented" | "added" | "modified" | "deleted" | "renamed";

const FILTER_CHIPS: { value: FileFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unviewed", label: "Unviewed" },
  { value: "commented", label: "Commented" },
  { value: "added", label: "Added" },
  { value: "modified", label: "Modified" },
  { value: "deleted", label: "Deleted" },
  { value: "renamed", label: "Renamed" },
];

interface PullRequestFilesPaneProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  prNumber: number;
  openFilePath: string | null;
  onFilePathChange: (filePath: string | null) => void;
  reviewComments?: ReadonlyArray<PullRequestReviewComment> | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PatchRender =
  | { kind: "files"; files: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

function renderPatch(patch: string | null | undefined, cacheScope: string): PatchRender | null {
  const normalized = (patch ?? "").trim();
  if (normalized.length === 0) return null;
  try {
    const parsed = parsePatchFiles(normalized, buildPatchCacheKey(normalized, cacheScope));
    const files = parsed.flatMap((entry) => entry.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }
  } catch {
    // fall through to raw
  }
  return { kind: "raw", text: normalized, reason: "Showing raw diff." };
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// FileDiffView (right pane)
// ---------------------------------------------------------------------------

interface FileDiffViewProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  prNumber: number;
  filePath: string;
  isViewed: boolean;
  onToggleViewed: () => void;
  onPrevious: () => void;
  onNext: () => void;
  canGoPrevious: boolean;
  canGoNext: boolean;
  positionLabel: string | null;
}

const FileDiffView = memo(function FileDiffView({
  environmentId,
  cwd,
  prNumber,
  filePath,
  isViewed,
  onToggleViewed,
  onPrevious,
  onNext,
  canGoPrevious,
  canGoNext,
  positionLabel,
}: FileDiffViewProps) {
  const { resolvedTheme } = useTheme();
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");

  const fileDiffQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? gitPrEnvironment.pullRequestFileDiff({ environmentId, input: { cwd, prNumber, filePath } })
      : null,
  );

  const patchRender = useMemo(
    () => renderPatch(fileDiffQuery.data?.diff, `pr-${prNumber}-file-${filePath}`),
    [fileDiffQuery.data?.diff, prNumber, filePath],
  );

  // Keyboard navigation: arrow keys for prev/next file
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
      if (event.key === "ArrowLeft" && canGoPrevious) {
        event.preventDefault();
        onPrevious();
      } else if (event.key === "ArrowRight" && canGoNext) {
        event.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [canGoPrevious, canGoNext, onPrevious, onNext]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!canGoPrevious}
              onClick={onPrevious}
              title="Previous file (←)"
              aria-label="Previous file"
            >
              <ChevronLeftIcon aria-hidden="true" />
            </Button>
            <label
              className="flex shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted-foreground"
              title={isViewed ? "Marked as viewed" : "Mark as viewed"}
            >
              <Checkbox
                checked={isViewed}
                onCheckedChange={(value) => {
                  if ((value === true) !== isViewed) onToggleViewed();
                }}
              />
              <span className="select-none">Viewed</span>
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!canGoNext}
              onClick={onNext}
              title="Next file (→)"
              aria-label="Next file"
            >
              <ChevronRightIcon aria-hidden="true" />
            </Button>
          </div>
          {positionLabel ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {positionLabel}
            </span>
          ) : null}
          <span className="min-w-0 truncate font-mono text-sm">{filePath}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleGroup
            variant="outline"
            size="xs"
            value={[diffStyle]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "unified" || next === "split") {
                setDiffStyle(next);
              }
            }}
          >
            <Toggle aria-label="Unified diff view" value="unified" title="Unified diff">
              <Rows3Icon className="size-3" />
            </Toggle>
            <Toggle aria-label="Split diff view" value="split" title="Split diff">
              <Columns2Icon className="size-3" />
            </Toggle>
          </ToggleGroup>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {fileDiffQuery.isLoading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            <Spinner className="mr-2 size-3.5" />
            Loading diff...
          </div>
        ) : fileDiffQuery.error !== null && !fileDiffQuery.data ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-3 text-center text-xs text-destructive">
            <AlertCircleIcon className="size-4" aria-hidden="true" />
            {fileDiffQuery.error ?? "Failed to load file diff."}
          </div>
        ) : patchRender?.kind === "files" ? (
          <div className="diff-render-surface">
            {patchRender.files.map((fileDiff) => (
              <div
                key={fileDiff.cacheKey ?? resolveFileDiffPath(fileDiff)}
                className="diff-render-file rounded-md"
              >
                <FileDiff
                  fileDiff={fileDiff}
                  options={{
                    diffStyle: diffStyle,
                    lineDiffType: "none",
                    overflow: "wrap",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme,
                  }}
                />
              </div>
            ))}
          </div>
        ) : patchRender?.kind === "raw" ? (
          <div>
            <p className="mb-2 text-[11px] text-muted-foreground/75">{patchRender.reason}</p>
            <pre className="overflow-auto rounded-md border border-border/70 bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
              {patchRender.text}
            </pre>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No diff available.
          </div>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// PullRequestFilesPane (main export)
// ---------------------------------------------------------------------------

export function PullRequestFilesPane({
  environmentId,
  cwd,
  prNumber,
  openFilePath,
  onFilePathChange,
  reviewComments,
}: PullRequestFilesPaneProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<FileFilter>("all");

  // ---- Data fetching -------------------------------------------------------

  const queryTarget =
    environmentId !== null && cwd !== null ? { environmentId, input: { cwd, prNumber } } : null;
  const diffQuery = useEnvironmentQuery(
    queryTarget ? gitPrEnvironment.pullRequestDiff(queryTarget) : null,
  );
  const viewedFilesQuery = useEnvironmentQuery(
    queryTarget ? gitPrEnvironment.pullRequestViewedFiles(queryTarget) : null,
  );
  const setFileViewed = useAtomCommand(gitPrEnvironment.setPullRequestFileViewed, {
    reportFailure: false,
  });

  const files = useMemo(() => diffQuery.data?.files ?? [], [diffQuery.data?.files]);
  const filePaths = useMemo(() => files.map((f) => f.path), [files]);
  const fullDiff = diffQuery.data?.fullDiff ?? "";

  const { isViewed, setViewed, toggleViewed, viewedCount, totalCount } = usePullRequestViewedFiles({
    cwd,
    prNumber,
    fullDiff,
    filePaths,
    githubViewedPaths: viewedFilesQuery.data?.viewedPaths,
    onSetViewed: useCallback(
      (filePath: string, viewed: boolean) => {
        if (environmentId === null || cwd === null) return;
        void setFileViewed({
          environmentId,
          input: { cwd, prNumber, path: filePath, viewed },
        });
      },
      [setFileViewed, environmentId, cwd, prNumber],
    ),
  });

  // ---- Line counts from full diff ------------------------------------------

  const lineCounts = useMemo(() => {
    if (!fullDiff) return new Map();
    try {
      const parsed = parsePatchFiles(fullDiff, buildPatchCacheKey(fullDiff, `pr-${prNumber}-full`));
      const allFiles = parsed.flatMap((entry) => entry.files);
      return fileLineCountsFromPatchFiles(allFiles);
    } catch {
      return new Map();
    }
  }, [fullDiff, prNumber]);

  // ---- Comment counts per file ----------------------------------------------

  const commentCountByFile = useMemo(() => {
    const counts = new Map<string, number>();
    if (!reviewComments) return counts;
    for (const comment of reviewComments) {
      if (comment.path) {
        counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
      }
    }
    return counts;
  }, [reviewComments]);

  // ---- Filtering ------------------------------------------------------------

  const filteredFiles = useMemo(() => {
    let result = files;

    // Apply status/state filter
    if (activeFilter !== "all") {
      result = result.filter((file) => {
        switch (activeFilter) {
          case "unviewed":
            return !isViewed(file.path);
          case "commented":
            return (commentCountByFile.get(file.path) ?? 0) > 0;
          case "added":
            return file.status === "A";
          case "modified":
            return file.status === "M";
          case "deleted":
            return file.status === "D";
          case "renamed":
            return file.status === "R";
          default:
            return true;
        }
      });
    }

    // Apply search query
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      result = result.filter((file) => {
        const basename = basenameOf(file.path).toLowerCase();
        const fullPath = file.path.toLowerCase();
        return basename.includes(query) || fullPath.includes(query);
      });
    }

    return result;
  }, [files, activeFilter, searchQuery, isViewed, commentCountByFile]);

  // ---- Navigation -----------------------------------------------------------

  const openFileIndex = useMemo(
    () => (openFilePath === null ? -1 : filePaths.indexOf(openFilePath)),
    [filePaths, openFilePath],
  );

  const goToFileAt = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= filePaths.length) return;
      const nextPath = filePaths[nextIndex];
      if (nextPath !== undefined) onFilePathChange(nextPath);
    },
    [filePaths, onFilePathChange],
  );

  const handlePreviousFile = useCallback(() => {
    if (openFileIndex <= 0) return;
    goToFileAt(openFileIndex - 1);
  }, [goToFileAt, openFileIndex]);

  const handleNextFile = useCallback(() => {
    if (openFileIndex < 0 || openFileIndex >= filePaths.length - 1) return;
    goToFileAt(openFileIndex + 1);
  }, [filePaths.length, goToFileAt, openFileIndex]);

  const canGoPrevious = openFileIndex > 0;
  const canGoNext = openFileIndex >= 0 && openFileIndex < filePaths.length - 1;
  const positionLabel = openFileIndex >= 0 ? `${openFileIndex + 1} / ${filePaths.length}` : null;

  // ---- Render ---------------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {/* Left sub-pane: file tree with search and filters */}
      <div className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border/70">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Files ({files.length})
          </h3>
          {totalCount > 0 ? (
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {viewedCount} / {totalCount} viewed
            </span>
          ) : null}
        </div>

        {/* Search input */}
        <div className="border-b border-border/70 px-3 py-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files..."
              className="h-7 w-full rounded-md border border-border/70 bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            />
          </div>
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-1 border-b border-border/70 px-3 py-2">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.value}
              type="button"
              onClick={() => setActiveFilter(chip.value)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                activeFilter === chip.value
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* File tree */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {diffQuery.isLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Spinner className="mr-2 size-3.5" />
              Loading files...
            </div>
          ) : diffQuery.error !== null && !diffQuery.data ? (
            <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-xs text-destructive">
              <AlertCircleIcon className="size-4" aria-hidden="true" />
              {diffQuery.error ?? "Failed to load diff."}
            </div>
          ) : filteredFiles.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {files.length === 0 ? "No files changed." : "No files match the current filter."}
            </p>
          ) : (
            <PullRequestFileTree
              files={filteredFiles}
              lineCounts={lineCounts}
              isViewed={isViewed}
              onSetViewed={setViewed}
              onJumpToFile={onFilePathChange}
              activePath={openFilePath}
            />
          )}
        </div>
      </div>

      {/* Right diff pane */}
      {openFilePath !== null ? (
        <FileDiffView
          environmentId={environmentId}
          cwd={cwd}
          prNumber={prNumber}
          filePath={openFilePath}
          isViewed={isViewed(openFilePath)}
          onToggleViewed={() => toggleViewed(openFilePath)}
          onPrevious={handlePreviousFile}
          onNext={handleNextFile}
          canGoPrevious={canGoPrevious}
          canGoNext={canGoNext}
          positionLabel={positionLabel}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a file to view its diff.
        </div>
      )}
    </div>
  );
}
