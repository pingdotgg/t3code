import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { cn } from "~/lib/utils";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  buildCommitFileTree,
  type CommitFile,
  flattenCommitFileTree,
  resolveCommitFileTreeSelection,
  toggleCommitFileTreeNode,
} from "./CommitFileTree.logic";

export function CommitFileTree(props: {
  files: ReadonlyArray<CommitFile>;
  excludedFiles: ReadonlySet<string>;
  isEditing: boolean;
  canOpenFile: boolean;
  onExcludedFilesChange: (excludedFiles: Set<string>) => void;
  onOpenFile: (path: string) => void;
}) {
  const { files, excludedFiles, isEditing, canOpenFile, onExcludedFilesChange, onOpenFile } = props;
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const tree = buildCommitFileTree(files);
  const rows = flattenCommitFileTree(tree, collapsedDirectories);

  const toggleDirectory = (path: string) => {
    setCollapsedDirectories((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  return rows.map(({ node, depth }) => {
    const selection = resolveCommitFileTreeSelection(node, excludedFiles);
    const isExcluded = selection === "none";
    const isDirectory = node.kind === "directory";
    const isExpanded = isDirectory && !collapsedDirectories.has(node.path);
    const label = (
      <>
        <span className={cn("min-w-0 flex-1 truncate", isExcluded && "text-muted-foreground")}>
          {node.name}
        </span>
        <span className="shrink-0">
          {isExcluded ? (
            <span className="text-muted-foreground">Excluded</span>
          ) : node.stat ? (
            <>
              <span className="text-diff-addition">+{formatDiffCount(node.stat.additions)}</span>
              <span className="text-muted-foreground"> / </span>
              <span className="text-diff-deletion">-{formatDiffCount(node.stat.deletions)}</span>
            </>
          ) : null}
        </span>
      </>
    );

    return (
      <div
        key={`${node.kind}:${node.path}`}
        className="flex w-full items-center gap-2 rounded-md py-1 pr-2 font-mono hover:bg-accent/50"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {isEditing && (
          <Checkbox
            aria-label={`Include ${node.path}`}
            checked={selection === "all"}
            indeterminate={selection === "some"}
            onCheckedChange={() =>
              onExcludedFilesChange(toggleCommitFileTreeNode(node, excludedFiles))
            }
          />
        )}
        {isDirectory ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
            aria-expanded={isExpanded}
            onClick={() => toggleDirectory(node.path)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0 text-muted-foreground", isExpanded && "rotate-90")}
            />
            {isExpanded ? (
              <FolderOpenIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            ) : (
              <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {label}
          </button>
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left enabled:cursor-pointer"
            disabled={!canOpenFile}
            aria-label={`Open ${node.path} in editor`}
            onClick={() => onOpenFile(node.path)}
          >
            <span aria-hidden="true" className="size-3.5 shrink-0" />
            {label}
          </button>
        )}
      </div>
    );
  });
}
