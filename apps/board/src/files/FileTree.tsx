import type { ProjectEntry } from "@t3tools/contracts";
import { FileTree as PierreTree, useFileTree } from "@pierre/trees/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { Tooltip } from "../ui/Tooltip";
import { coalesceReentrantCalls, readExpanded, writeExpanded } from "./treeExpansion";
import { buildFileTreePathUpdates, shouldRebuildFileTree } from "./treePaths";
import { useDirectoryEntries } from "./useDirectoryEntries";

const TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
`;

// SAFETY: the tree reads these custom properties from its host element, which CSSProperties does not name.
const TREE_STYLE = {
  colorScheme: "dark",
  "--trees-fg-override": "var(--color-fg)",
  "--trees-fg-muted-override": "var(--color-muted)",
  "--trees-status-ignored-override": "var(--color-faint)",
} as React.CSSProperties;

const treePath = (entry: ProjectEntry) =>
  entry.kind === "directory" ? `${entry.path}/` : entry.path;
const withoutSlash = (path: string) => path.replace(/\/$/, "");

/** Two frames: the first commits what the tree was given, the second runs after it has been painted. */
const afterPaint = (done: () => void) => requestAnimationFrame(() => requestAnimationFrame(done));

/**
 * One root's folders, listed lazily as they open. `onOpenFile` receives the path relative to the
 * root. Open folders are remembered per root.
 */
export function FileTree({
  environmentId,
  cwd,
  title,
  onOpenFile,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  /** What heads the tree, beside its refresh button. */
  title: ReactNode;
  onOpenFile: (path: string) => void;
}) {
  const { entries, attach, load, refresh, ready, loading, error } = useDirectoryEntries(
    environmentId,
    cwd,
  );
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const directoryPaths = useMemo(
    () => entries.filter((entry) => entry.kind === "directory").map(treePath),
    [entries],
  );
  const kinds = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(new Map());
  const previousPaths = useRef<ReadonlyArray<string> | null>(null);
  const expanded = useRef(new Set<string>());
  // Folders open when the root was last shown. Each reopens once its parent has listed it.
  const [pending] = useState(() => new Set(readExpanded(cwd)));
  const selectionHandler = useRef(onOpenFile);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    paths: [],
    search: false,
    unsafeCSS: TREE_CSS,
    onSelectionChange: (selected) => {
      const path = selected.at(-1)?.replace(/\/$/, "");
      if (path !== undefined && kinds.current.get(path) === "file") selectionHandler.current(path);
    },
  });

  // The tree model is outside React, so what the listings change is pushed into it here. React
  // runs this again, and the cleanup first, whenever one of its inputs changes.
  const sync = useCallback(
    (host: HTMLDivElement | null) => {
      if (host === null) return;
      selectionHandler.current = onOpenFile;
      kinds.current = new Map(entries.map((entry) => [entry.path, entry.kind]));
      model.setGitStatus(
        entries
          .filter((entry) => entry.ignored)
          .map((entry) => ({ path: treePath(entry), status: "ignored" })),
      );
      if (ready && previousPaths.current !== treePaths) {
        const before = previousPaths.current;
        previousPaths.current = treePaths;
        if (before === null) {
          model.resetPaths(treePaths);
        } else {
          const updates = buildFileTreePathUpdates(before, treePaths);
          if (shouldRebuildFileTree(before, treePaths, updates)) {
            model.resetPaths(treePaths, { initialExpandedPaths: [...expanded.current] });
          } else if (updates.length > 0) {
            model.batch(updates);
          }
        }
      }
      const known = new Set(directoryPaths);
      for (const path of expanded.current) if (!known.has(path)) expanded.current.delete(path);
      // Restoring calls item.expand(), which notifies subscribers synchronously.
      const loadExpanded = coalesceReentrantCalls(() => {
        let changed = false;
        for (const path of directoryPaths) {
          const item = model.getItem(path);
          if (item?.isDirectory() !== true) continue;
          if (pending.delete(path) && "expand" in item) item.expand();
          if ("isExpanded" in item && item.isExpanded()) {
            if (expanded.current.has(path)) continue;
            expanded.current.add(path);
            changed = true;
            performance.mark("board:tree-expand", { detail: { path } });
            void load(withoutSlash(path)).then(() =>
              afterPaint(() => performance.mark("board:tree-painted", { detail: { path } })),
            );
          } else if (expanded.current.delete(path)) {
            changed = true;
          }
        }
        if (changed) writeExpanded(cwd, [...expanded.current, ...pending]);
      });
      loadExpanded();
      return model.subscribe(loadExpanded);
    },
    [
      entries,
      treePaths,
      directoryPaths,
      ready,
      model,
      load,
      cwd,
      pending,
      onOpenFile,
      selectionHandler,
    ],
  );
  const mount = useCallback(
    (host: HTMLDivElement | null) => (host === null ? undefined : attach()),
    [attach],
  );

  return (
    <div ref={mount} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5 text-[11px] text-muted">
        <div className="min-w-0 flex-1">{title}</div>
        <span role="status" className="shrink-0">
          {!ready && error === null ? "Loading files" : loading.size > 0 ? "Loading" : ""}
        </span>
        <Tooltip text="Refresh the files" side="bottom" align="end">
          <button
            type="button"
            aria-label="Refresh the files"
            onClick={refresh}
            className="grid size-6 place-items-center rounded-md hover:bg-hover hover:text-fg"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      {error !== null && (
        <button
          type="button"
          onClick={refresh}
          className="px-3 py-2 text-left text-[12px] text-red-300"
        >
          {error} Click to retry.
        </button>
      )}
      <div ref={sync} className="flex min-h-0 flex-1 flex-col">
        <PierreTree
          model={model}
          aria-label="Files"
          data-testid="file-tree"
          className="min-h-0 flex-1 overflow-hidden"
          style={TREE_STYLE}
        />
      </div>
    </div>
  );
}
