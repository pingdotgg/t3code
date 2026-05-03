import { type EnvironmentId, type ProjectEntry } from "@forma/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  IconChevronRight as ChevronRightIcon,
  IconFolder as FolderIcon,
  IconFolderFill as FolderClosedIcon,
  IconProgressIndicator as LoaderIcon,
} from "symbols-react";
import { memo, useCallback, useEffect, useState } from "react";

import { prefetchProjectFileForEditor } from "../lib/projectFileReadCache";
import { projectListEntriesQueryOptions } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { scheduleWorkspaceDirectoryPrefetch } from "../lib/workspaceFilePrefetch";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";

const expandedDirectoryPathsBySessionKey = new Map<string, readonly string[]>();

interface WorkspaceFilesTreeProps {
  environmentId: EnvironmentId;
  cwd: string;
  sessionKey: string;
  resolvedTheme: "light" | "dark";
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
}

function readExpandedDirectoryPaths(sessionKey: string): ReadonlySet<string> {
  return new Set(expandedDirectoryPathsBySessionKey.get(sessionKey) ?? []);
}

function writeExpandedDirectoryPaths(sessionKey: string, paths: ReadonlySet<string>): void {
  if (paths.size === 0) {
    expandedDirectoryPathsBySessionKey.delete(sessionKey);
    return;
  }

  expandedDirectoryPathsBySessionKey.set(
    sessionKey,
    [...paths].toSorted((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
    ),
  );
}

export function __resetWorkspaceFilesTreeSessionStateForTests(): void {
  expandedDirectoryPathsBySessionKey.clear();
}

export const WorkspaceFilesTree = memo(function WorkspaceFilesTree(props: WorkspaceFilesTreeProps) {
  const [expandedDirectoryPaths, setExpandedDirectoryPaths] = useState(() =>
    readExpandedDirectoryPaths(props.sessionKey),
  );

  useEffect(() => {
    setExpandedDirectoryPaths(readExpandedDirectoryPaths(props.sessionKey));
  }, [props.sessionKey]);

  const setDirectoryExpanded = useCallback(
    (path: string, expanded: boolean) => {
      setExpandedDirectoryPaths((current) => {
        const nextExpandedPaths = new Set(current);
        if (expanded) {
          nextExpandedPaths.add(path);
        } else {
          nextExpandedPaths.delete(path);
        }

        writeExpandedDirectoryPaths(props.sessionKey, nextExpandedPaths);
        return nextExpandedPaths;
      });
    },
    [props.sessionKey],
  );

  return (
    <WorkspaceDirectoryEntries
      cwd={props.cwd}
      depth={0}
      environmentId={props.environmentId}
      expandedDirectoryPaths={expandedDirectoryPaths}
      parentPath={null}
      resolvedTheme={props.resolvedTheme}
      selectedFilePath={props.selectedFilePath}
      setDirectoryExpanded={setDirectoryExpanded}
      onSelectFile={props.onSelectFile}
    />
  );
});

const WorkspaceDirectoryEntries = memo(function WorkspaceDirectoryEntries(props: {
  environmentId: EnvironmentId;
  cwd: string;
  parentPath: string | null;
  depth: number;
  expandedDirectoryPaths: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  selectedFilePath: string | null;
  setDirectoryExpanded: (path: string, expanded: boolean) => void;
  onSelectFile: (filePath: string) => void;
}) {
  const entriesQuery = useQuery(
    projectListEntriesQueryOptions({
      environmentId: props.environmentId,
      cwd: props.cwd,
      ...(props.parentPath !== null ? { relativePath: props.parentPath } : {}),
    }),
  );
  const entries = entriesQuery.data?.entries;

  useEffect(() => {
    if (!entries || entries.length === 0) {
      return;
    }

    return scheduleWorkspaceDirectoryPrefetch({
      environmentId: props.environmentId,
      cwd: props.cwd,
      entries,
    });
  }, [entries, props.cwd, props.environmentId]);

  if (entriesQuery.isLoading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground",
          props.depth > 0 && "pl-7",
        )}
      >
        <LoaderIcon className="size-3 animate-spin" />
        Loading files…
      </div>
    );
  }

  if (entriesQuery.error) {
    return (
      <div className={cn("px-2 py-2 text-xs text-red-500/80", props.depth > 0 && "pl-7")}>
        {entriesQuery.error instanceof Error
          ? entriesQuery.error.message
          : "Unable to load workspace files."}
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return props.depth === 0 ? (
      <div className="px-2 py-2 text-xs text-muted-foreground">No files in this workspace.</div>
    ) : (
      <div className="px-2 py-1.5 pl-7 text-xs text-muted-foreground">Empty</div>
    );
  }

  return (
    <div className="space-y-0.5">
      {entries.map((entry) =>
        entry.kind === "directory" ? (
          <WorkspaceDirectoryNode
            key={entry.path}
            cwd={props.cwd}
            depth={props.depth}
            entry={entry}
            environmentId={props.environmentId}
            expanded={props.expandedDirectoryPaths.has(entry.path)}
            expandedDirectoryPaths={props.expandedDirectoryPaths}
            resolvedTheme={props.resolvedTheme}
            selectedFilePath={props.selectedFilePath}
            setDirectoryExpanded={props.setDirectoryExpanded}
            onSelectFile={props.onSelectFile}
          />
        ) : (
          <WorkspaceFileNode
            key={entry.path}
            cwd={props.cwd}
            depth={props.depth}
            entry={entry}
            environmentId={props.environmentId}
            resolvedTheme={props.resolvedTheme}
            selected={props.selectedFilePath === entry.path}
            onSelectFile={props.onSelectFile}
          />
        ),
      )}
    </div>
  );
});

const WorkspaceDirectoryNode = memo(function WorkspaceDirectoryNode(props: {
  environmentId: EnvironmentId;
  cwd: string;
  depth: number;
  entry: ProjectEntry;
  expanded: boolean;
  expandedDirectoryPaths: ReadonlySet<string>;
  resolvedTheme: "light" | "dark";
  selectedFilePath: string | null;
  setDirectoryExpanded: (path: string, expanded: boolean) => void;
  onSelectFile: (filePath: string) => void;
}) {
  const leftPadding = 8 + props.depth * 14;

  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => props.setDirectoryExpanded(props.entry.path, !props.expanded)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-2.5 shrink-0 fill-muted-foreground/70 transition-transform group-hover:fill-foreground/80",
            props.expanded && "rotate-90",
          )}
        />
        {props.expanded ? (
          <FolderIcon className="size-3.5 shrink-0 fill-muted-foreground/75" />
        ) : (
          <FolderClosedIcon className="size-3.5 shrink-0 fill-muted-foreground/75" />
        )}
        <span className="text-code-compact truncate font-mono text-muted-foreground/90 group-hover:text-foreground/90">
          {basename(props.entry.path)}
        </span>
      </button>
      {props.expanded ? (
        <WorkspaceDirectoryEntries
          cwd={props.cwd}
          depth={props.depth + 1}
          environmentId={props.environmentId}
          expandedDirectoryPaths={props.expandedDirectoryPaths}
          parentPath={props.entry.path}
          resolvedTheme={props.resolvedTheme}
          selectedFilePath={props.selectedFilePath}
          setDirectoryExpanded={props.setDirectoryExpanded}
          onSelectFile={props.onSelectFile}
        />
      ) : null}
    </div>
  );
});

const WorkspaceFileNode = memo(function WorkspaceFileNode(props: {
  cwd: string;
  depth: number;
  entry: ProjectEntry;
  environmentId: EnvironmentId;
  resolvedTheme: "light" | "dark";
  selected: boolean;
  onSelectFile: (filePath: string) => void;
}) {
  const leftPadding = 8 + props.depth * 14;
  const prefetchFile = useCallback(() => {
    prefetchProjectFileForEditor({
      environmentId: props.environmentId,
      cwd: props.cwd,
      relativePath: props.entry.path,
    });
  }, [props.cwd, props.entry.path, props.environmentId]);

  return (
    <button
      type="button"
      className={cn(
        "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80",
        props.selected && "bg-accent/60 text-accent-foreground hover:bg-accent/70",
      )}
      style={{ paddingLeft: `${leftPadding}px` }}
      onFocus={prefetchFile}
      onMouseEnter={prefetchFile}
      onClick={() => {
        prefetchFile();
        props.onSelectFile(props.entry.path);
      }}
      title={props.entry.path}
    >
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      <VscodeEntryIcon
        pathValue={props.entry.path}
        kind="file"
        theme={props.resolvedTheme}
        className="size-3.5 text-muted-foreground/70"
      />
      <span className="text-code-compact truncate font-mono text-muted-foreground/80 group-hover:text-foreground/90">
        {basename(props.entry.path)}
      </span>
    </button>
  );
});

function basename(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments.at(-1) ?? path;
}
