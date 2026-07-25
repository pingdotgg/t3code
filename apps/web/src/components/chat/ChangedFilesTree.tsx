import { type TurnId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState } from "react";
import { type TurnDiffFileChange } from "../../types";
import {
  buildTurnDiffTree,
  summarizeTurnDiffStats,
  type TurnDiffTreeNode,
} from "../../lib/turnDiffTree";
import {
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderIcon,
  FolderClosedIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  changedFileName,
  selectChangedFilePreview,
  summarizeChangedFileScopes,
} from "./changedFilesPresentation";

const EMPTY_DIRECTORY_OVERRIDES: Record<string, boolean> = {};

export const ChangedFilesCard = memo(function ChangedFilesCard(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  expanded: boolean;
  showCompactPreview: boolean;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onExpandedChange: (expanded: boolean) => void;
  onToggleAllDirectories: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const {
    turnId,
    files,
    expanded,
    showCompactPreview,
    allDirectoriesExpanded,
    resolvedTheme,
    onExpandedChange,
    onToggleAllDirectories,
    onOpenTurnDiff,
  } = props;
  const summaryStat = useMemo(() => summarizeTurnDiffStats(files), [files]);
  const scopeSummary = useMemo(() => summarizeChangedFileScopes(files), [files]);
  const previewFiles = useMemo(() => selectChangedFilePreview(files), [files]);
  const compactPreviewVisible = showCompactPreview && !expanded;

  return (
    <div
      className="mt-4 rounded-2xl border border-border/70 bg-secondary p-2 dark:border-transparent dark:bg-input/32"
      data-changed-files-state={
        expanded ? "expanded" : compactPreviewVisible ? "preview" : "collapsed"
      }
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 rounded-xl px-1",
          expanded &&
            "sticky top-2 z-10 mb-2 bg-secondary dark:bg-[color-mix(in_srgb,var(--foreground)_2.5%,var(--background))]",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onExpandedChange(!expanded)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
          <span className="flex min-w-0 items-center gap-1 whitespace-nowrap font-medium text-foreground text-xs leading-4">
            <span>
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </span>
            {hasNonZeroStat(summaryStat) && (
              <DiffStatLabel
                additions={summaryStat.additions}
                className="text-xs leading-4"
                deletions={summaryStat.deletions}
                layout="inline"
              />
            )}
          </span>
          <span className="ml-1 hidden truncate text-[11px] text-muted-foreground group-hover:text-foreground/80 sm:inline">
            {expanded ? "Hide files" : "Show files"}
          </span>
        </button>
        <div className="flex items-center gap-1.5">
          {expanded ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    className="!size-[22px]"
                    aria-label={
                      allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                    }
                    data-scroll-anchor-ignore
                    onClick={onToggleAllDirectories}
                  />
                }
              >
                {allDirectoriesExpanded ? (
                  <ChevronsDownUpIcon className="size-3" />
                ) : (
                  <ChevronsUpDownIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-label="Open diff"
                  onClick={() => onOpenTurnDiff(turnId, files[0]?.path)}
                />
              }
            >
              <FileDiffIcon className="size-3" />
              <span className="hidden sm:inline">Open diff</span>
            </TooltipTrigger>
            <TooltipPopup side="top">Open the full diff</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {expanded ? (
        <ChangedFilesTree
          key={`changed-files-tree:${turnId}`}
          turnId={turnId}
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme={resolvedTheme}
          onOpenTurnDiff={onOpenTurnDiff}
        />
      ) : compactPreviewVisible ? (
        <div className="px-2 pb-1.5 pt-1">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            {scopeSummary.map((scope, index) => (
              <span key={scope.label} className="inline-flex items-center gap-1">
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                <span className="font-mono text-foreground/75">{scope.label}</span>
                <span>
                  {scope.fileCount} file{scope.fileCount === 1 ? "" : "s"}
                </span>
              </span>
            ))}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {previewFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                title={file.path}
                className="inline-flex max-w-48 items-center gap-1 rounded-md border border-border/70 bg-background/45 px-1.5 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onOpenTurnDiff(turnId, file.path)}
              >
                <PierreEntryIcon
                  pathValue={file.path}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3 shrink-0 text-muted-foreground/70"
                />
                <span className="truncate">{changedFileName(file.path)}</span>
              </button>
            ))}
            <button
              type="button"
              className="rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onExpandedChange(true)}
            >
              Show all {files.length} files
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
});

export const ChangedFilesTree = memo(function ChangedFilesTree(props: {
  turnId: TurnId;
  files: ReadonlyArray<TurnDiffFileChange>;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { files, allDirectoriesExpanded, onOpenTurnDiff, resolvedTheme, turnId } = props;
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
            <span className="truncate font-mono text-[11px] text-muted-foreground/90 group-hover:text-foreground/90">
              {node.name}
            </span>
            {hasNonZeroStat(node.stat) && (
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
        className="group flex w-full items-center gap-1.5 rounded-xl py-1 pr-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        style={{ paddingLeft: `${leftPadding}px` }}
        onClick={() => onOpenTurnDiff(turnId, node.path)}
      >
        {hasDirectoryNodes || depth > 0 ? (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        ) : null}
        <PierreEntryIcon
          pathValue={node.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5 text-muted-foreground/70"
        />
        <span className="truncate font-mono text-[11px] text-muted-foreground/80 group-hover:text-foreground/90">
          {node.name}
        </span>
        {node.stat && (
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
