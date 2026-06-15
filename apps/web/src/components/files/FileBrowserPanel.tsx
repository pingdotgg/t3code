import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  onOpenFile: (relativePath: string) => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const [entries, setEntries] = useState<readonly ProjectEntry[]>([]);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [isLoadingEntries, setIsLoadingEntries] = useState(true);
  const [isTruncated, setIsTruncated] = useState(false);
  const entryKindsRef = useRef(new Map<string, ProjectEntry["kind"]>());
  const requestGenerationRef = useRef(0);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  const loadEntries = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    requestGenerationRef.current += 1;
    const generation = requestGenerationRef.current;
    setIsLoadingEntries(true);
    setEntriesError(null);

    if (!api) {
      setEntriesError("Environment is not connected.");
      setIsLoadingEntries(false);
      return;
    }

    void api.projects.listEntries({ cwd }).then(
      (result) => {
        if (generation !== requestGenerationRef.current) return;
        entryKindsRef.current = new Map(
          result.entries.map((entry) => [entry.path, entry.kind] as const),
        );
        setEntries(result.entries);
        setIsTruncated(result.truncated);
        model.resetPaths(result.entries.map(treePath));
        setIsLoadingEntries(false);
      },
      (error: unknown) => {
        if (generation !== requestGenerationRef.current) return;
        setEntriesError(error instanceof Error ? error.message : String(error));
        setIsLoadingEntries(false);
      },
    );
  }, [cwd, environmentId, model]);

  useEffect(() => {
    loadEntries();
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [loadEntries]);

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {isLoadingEntries ? "Indexing…" : `${fileCount.toLocaleString()} files`}
            {isTruncated ? " · partial" : ""}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          onClick={loadEntries}
        >
          <RefreshCw className={cn("size-3.5", isLoadingEntries && "animate-spin")} />
        </button>
      </div>
      {entriesError ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesError}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
