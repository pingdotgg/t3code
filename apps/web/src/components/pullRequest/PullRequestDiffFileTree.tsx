import type { FileDiffMetadata } from "@pierre/diffs";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { Button } from "../ui/button";
import { getPullRequestFileLoadState } from "./pullRequestDiff.logic";

const NO_EXPANDED_DIRECTORIES: ReadonlyArray<string> = [];

function toGitStatus(file: FileDiffMetadata): GitStatusEntry {
  const path = resolveFileDiffPath(file);
  switch (file.type) {
    case "new":
      return { path, status: "added" };
    case "deleted":
      return { path, status: "deleted" };
    case "rename-pure":
    case "rename-changed":
      return { path, status: "renamed" };
    case "change":
      return { path, status: "modified" };
  }
}

function collectDirectoryPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    let directory = "";
    for (const segment of segments.slice(0, -1)) {
      directory += `${segment}/`;
      directories.add(directory);
    }
  }
  return [...directories];
}

/** The one bulk tree action coordinated by the pull request diff toolbar. */
export interface PullRequestDiffFileTreeHandle {
  /** Expands or collapses every directory currently loaded in the tree. */
  readonly setAllDirectoriesExpanded: (expanded: boolean) => void;
}

/** A path-first Pierre tree for the portion of a pull-request diff loaded so far. */
export function PullRequestDiffFileTree({
  ref,
  files,
  totalFileCount,
  hasMore,
  isLoadingMore,
  loadMoreFailed,
  initiallyExpanded,
  onLoadMore,
  onSelectFile,
}: {
  readonly ref?: Ref<PullRequestDiffFileTreeHandle>;
  readonly files: ReadonlyArray<FileDiffMetadata>;
  /** Null when the selected host commit does not report its own aggregate file count. */
  readonly totalFileCount: number | null;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMoreFailed: boolean;
  /** The persisted expansion used when the sidebar mounts. */
  readonly initiallyExpanded: boolean;
  readonly onLoadMore: () => void;
  readonly onSelectFile: (path: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const paths = useMemo(() => files.map(resolveFileDiffPath), [files]);
  const directoryPaths = useMemo(() => collectDirectoryPaths(paths), [paths]);
  const gitStatus = useMemo(() => files.map(toGitStatus), [files]);
  const filePathsRef = useRef<ReadonlySet<string>>(new Set(paths));
  const onSelectFileRef = useRef(onSelectFile);
  const previousPathsRef = useRef<ReadonlyArray<string>>(paths);
  const previousDirectoryPathsRef = useRef<ReadonlyArray<string>>(directoryPaths);
  const newDirectoryExpansionRef = useRef<"open" | "closed">(initiallyExpanded ? "open" : "closed");
  const [hasRequestedMore, setHasRequestedMore] = useState(false);
  const fileLoadState = getPullRequestFileLoadState(files.length, totalFileCount, hasMore);
  const progressTotal = fileLoadState.knownTotalFileCount;
  const progressPercent =
    progressTotal === null || progressTotal === 0 ? null : (files.length / progressTotal) * 100;
  const loadedFileCount = files.length.toLocaleString();
  const loadedFileProgress =
    progressTotal === null
      ? `${loadedFileCount} loaded`
      : `${loadedFileCount} of ${progressTotal.toLocaleString()} loaded`;

  useEffect(() => {
    filePathsRef.current = new Set(paths);
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile, paths]);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpandedPaths: initiallyExpanded ? directoryPaths : NO_EXPANDED_DIRECTORIES,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const path = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (path && filePathsRef.current.has(path)) {
        onSelectFileRef.current(path);
      }
    },
    paths,
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    if (previousPathsRef.current === paths) return;
    const previousDirectoryPaths = previousDirectoryPathsRef.current;
    const previousDirectoryPathSet = new Set(previousDirectoryPaths);
    const previouslyExpandedPaths = new Set(
      previousDirectoryPaths.filter((path) => {
        const item = model.getItem(path);
        return item !== null && "isExpanded" in item && item.isExpanded();
      }),
    );
    const nextExpandedPaths = directoryPaths.filter((path) =>
      previousDirectoryPathSet.has(path)
        ? previouslyExpandedPaths.has(path)
        : newDirectoryExpansionRef.current === "open",
    );
    previousPathsRef.current = paths;
    previousDirectoryPathsRef.current = directoryPaths;
    model.resetPaths(paths, { initialExpandedPaths: nextExpandedPaths });
  }, [directoryPaths, model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  const setAllDirectoriesExpanded = useCallback(
    (expanded: boolean) => {
      newDirectoryExpansionRef.current = expanded ? "open" : "closed";
      model.resetPaths(paths, {
        initialExpandedPaths: expanded ? directoryPaths : NO_EXPANDED_DIRECTORIES,
      });
      model.setGitStatus(gitStatus);
    },
    [directoryPaths, gitStatus, model, paths],
  );
  useImperativeHandle(ref, () => ({ setAllDirectoriesExpanded }), [setAllDirectoriesExpanded]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 text-xs text-muted-foreground"
        data-surface-subheader
      >
        <span className="font-medium text-foreground">Files</span>
        <span className="ml-auto min-w-6 shrink-0 text-right tabular-nums">
          {files.length}
          {progressTotal !== null && progressTotal > files.length
            ? ` of ${progressTotal}`
            : fileLoadState.displayedCountIsLowerBound
              ? "+"
              : ""}
        </span>
      </div>
      <FileTree
        model={model}
        aria-label="Pull request files"
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      {hasMore ? (
        <div className="shrink-0 border-t border-border/60 p-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-busy={isLoadingMore}
            className="relative w-full overflow-hidden bg-transparent tabular-nums pointer-coarse:overflow-visible dark:bg-transparent"
            disabled={isLoadingMore}
            onClick={() => {
              setHasRequestedMore(true);
              onLoadMore();
            }}
          >
            {progressPercent === null ? null : (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-primary/8 transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${progressPercent}%` }}
              />
            )}
            <span className="relative z-10" aria-live="polite">
              {loadMoreFailed ? "Retry" : isLoadingMore ? "Loading" : "Load more"}
              {` · ${loadedFileProgress}`}
            </span>
          </Button>
        </div>
      ) : hasRequestedMore ? (
        <div
          role="status"
          className="flex h-11 shrink-0 items-center justify-center border-t border-border/60 px-3 text-xs text-muted-foreground tabular-nums sm:h-10"
        >
          All {loadedFileCount} {files.length === 1 ? "file" : "files"} loaded
        </div>
      ) : null}
    </div>
  );
}
