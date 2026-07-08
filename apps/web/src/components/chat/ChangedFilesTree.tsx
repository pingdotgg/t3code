import { type TurnDiffScope, type TurnId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { type TurnDiffFileChange } from "../../types";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { ChevronRightIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { readLocalApi } from "~/localApi";
import { toastManager } from "../ui/toast";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  diffScope?: TurnDiffScope;
  workspaceRoot?: string | undefined;
}) {
  const {
    files,
    allDirectoriesExpanded,
    onOpenTurnDiff,
    resolvedTheme,
    turnId,
    diffScope,
    workspaceRoot,
  } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
  const hasDirectoryNodes = directoryPathsKey.length > 0;
  const expansionStateKey = `${allDirectoriesExpanded ? "expanded" : "collapsed"}\u0000${directoryPathsKey}`;
  const [directoryExpansionState, setDirectoryExpansionState] = useState<{
    key: string;
    overrides: Record<string, boolean>;
  }>(() => ({
    key: expansionStateKey,
    overrides: {},
  }));
  const expandedDirectories =
    directoryExpansionState.key === expansionStateKey
      ? directoryExpansionState.overrides
      : EMPTY_DIRECTORY_OVERRIDES;

  const toggleDirectory = useCallback(
    (pathValue: string) => {
      setDirectoryExpansionState((current) => {
        const nextOverrides = current.key === expansionStateKey ? current.overrides : {};
        return {
          key: expansionStateKey,
          overrides: {
            ...nextOverrides,
            [pathValue]: !(nextOverrides[pathValue] ?? allDirectoriesExpanded),
          },
        };
      });
    },
    [allDirectoriesExpanded, expansionStateKey],
  );

  const showFileManagerContextMenu = useCallback(
    (event: ReactMouseEvent, pathValue: string) => {
      if (!workspaceRoot) return;
      event.preventDefault();
      event.stopPropagation();

      const targetPath = joinWorkspacePath(workspaceRoot, pathValue);
      const localApi = readLocalApi();
      if (!localApi) return;
      const fallbackPosition = window.desktopBridge
        ? undefined
        : {
            x: event.clientX,
            y: event.clientY,
          };

      void localApi.contextMenu
        .show([{ id: "open-in-finder", label: "Open in Finder" }], fallbackPosition)
        .then((selected) => {
          if (selected !== "open-in-finder") return;
          return localApi.shell.revealInFileManager(targetPath);
        })
        .catch((error: unknown) => {
          toastManager.add({
            title: "Could not open in Finder",
            description: error instanceof Error ? error.message : "Unable to reveal path.",
            type: "error",
          });
        });
    },
    [workspaceRoot],
  );

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
            onContextMenu={(event) => showFileManagerContextMenu(event, node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover:text-foreground/80",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span className="truncate font-mono text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[0.85em] tabular-nums">
                <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
              </span>
            )}
          </button>
          {isExpanded && (
            <div className="space-y-0.5">
              {node.children.map((childNode) => renderTreeNode(childNode, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        key={`file:${node.path}`}
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path, diffScope)}
        onContextMenu={(event) => showFileManagerContextMenu(event, node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="truncate font-mono text-muted-foreground/80 group-hover:text-foreground/90">
          {node.name}
        </span>
        {node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[0.85em] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-0.5" style={{ fontSize: "var(--app-code-font-size)" }}>
      {treeNodes.map((node) => renderTreeNode(node, 0))}
    </div>
  );
});

function joinWorkspacePath(workspaceRoot: string, pathValue: string): string {
  const trimmedRoot = workspaceRoot.replace(/\/+$/, "");
  const trimmedPath = pathValue.replace(/^\/+/, "");
  return `${trimmedRoot}/${trimmedPath}`;
}

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
