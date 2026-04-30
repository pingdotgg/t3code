import { memo, useCallback, useMemo, useState } from "react";
import {
  buildTurnDiffTree,
  type TurnDiffTreeEntryInput,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import { ChevronRightIcon, FolderIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  files: ReadonlyArray<TurnDiffTreeEntryInput>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onSelectFile: (filePath: string) => void;
  selectedFilePath?: string | null;
  showStats?: boolean;
}) {
  const {
    files,
    allDirectoriesExpanded,
    onSelectFile,
    resolvedTheme,
    selectedFilePath = null,
    showStats = true,
  } = props;
  const treeNodes = useMemo(() => buildTurnDiffTree(files), [files]);
  const directoryPathsKey = useMemo(
    () => collectDirectoryPaths(treeNodes).join("\u0000"),
    [treeNodes],
  );
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

  const renderTreeNode = (node: TurnDiffTreeNode, depth: number) => {
    const leftPadding = 8 + depth * 14;
    if (node.kind === "directory") {
      const isExpanded = expandedDirectories[node.path] ?? allDirectoriesExpanded;
      return (
        <div key={`dir:${node.path}`}>
          <button
            type="button"
            data-scroll-anchor-ignore
            className="group/tree-row flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80"
            style={{ paddingLeft: `${leftPadding}px` }}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
                isExpanded && "rotate-90",
              )}
            />
            {isExpanded ? (
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            ) : (
              <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
            )}
            <span
              data-tree-label
              className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover/tree-row:text-foreground/90"
            >
              {node.name}
            </span>
            {showStats && hasNonZeroStat(node.stat) && (
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
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
        className={cn(
          "group/tree-row flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-background/80",
          selectedFilePath === node.path && "bg-accent text-accent-foreground hover:bg-accent",
        )}
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onSelectFile(node.path)}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <VscodeEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span
          data-tree-label
          className={cn(
            "truncate font-mono text-[11px] text-muted-foreground/80 group-hover/tree-row:text-foreground/90",
            selectedFilePath === node.path && "text-accent-foreground",
          )}
        >
          {node.name}
        </span>
        {showStats && node.stat && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
            <DiffStatLabel additions={node.stat.additions} deletions={node.stat.deletions} />
          </span>
        )}
      </button>
    );
  };

  return <div className="space-y-0.5">{treeNodes.map((node) => renderTreeNode(node, 0))}</div>;
});

function collectDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}
