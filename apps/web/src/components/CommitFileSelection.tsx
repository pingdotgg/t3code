import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { VcsStatusResult } from "@t3tools/contracts";
import { useState } from "react";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import {
  buildCommitFileTree,
  flattenCommitFileTree,
  toggleCommitFiles,
  type CommitFileNode,
} from "@t3tools/client-runtime/commit-file-tree";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { StartTruncatedPath } from "./StartTruncatedPath";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ScrollArea } from "./ui/scroll-area";

type WorkingTreeFile = VcsStatusResult["workingTree"]["files"][number];

export function CommitFileSelection({
  files,
  excludedFiles,
  isEditing,
  onExcludedFilesChange,
  onEditingChange,
  onOpenFile,
  canOpenFile,
}: {
  files: readonly WorkingTreeFile[];
  excludedFiles: ReadonlySet<string>;
  isEditing: boolean;
  onExcludedFilesChange: (files: ReadonlySet<string>) => void;
  onEditingChange: (editing: boolean) => void;
  onOpenFile: (path: string) => void;
  canOpenFile: boolean;
}) {
  const [groupByDirectory, setGroupByDirectory] = useLocalStorage(
    "git-files-group-by-directory",
    false,
    Schema.Boolean,
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = groupByDirectory ? buildCommitFileTree(files) : [];
  const rows = groupByDirectory
    ? flattenCommitFileTree(tree, collapsed)
    : files.map((file) => ({
        node: { kind: "file", name: file.path, path: file.path, file } satisfies CommitFileNode,
        depth: 0,
      }));
  const selectedFiles = files.filter((file) => !excludedFiles.has(file.path));
  const allSelected = selectedFiles.length === files.length;
  const noneSelected = selectedFiles.length === 0;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isEditing && files.length > 0 && (
            <Checkbox
              aria-label="Select all files"
              checked={allSelected}
              indeterminate={!allSelected && !noneSelected}
              onCheckedChange={() => {
                onExcludedFilesChange(
                  allSelected ? new Set(files.map((file) => file.path)) : new Set(),
                );
              }}
            />
          )}
          <span className="text-muted-foreground">Files</span>
          {!allSelected && !isEditing && (
            <span className="text-muted-foreground">
              ({selectedFiles.length} of {files.length})
            </span>
          )}
        </div>
        {files.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox checked={groupByDirectory} onCheckedChange={setGroupByDirectory} />
              Group by directory
            </label>
            <Button variant="ghost" size="xs" onClick={() => onEditingChange(!isEditing)}>
              {isEditing ? "Done" : "Edit"}
            </Button>
          </div>
        )}
      </div>
      {files.length === 0 ? (
        <p className="font-medium">none</p>
      ) : (
        <div className="space-y-2">
          <div className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
            <ScrollArea>
              <div className="space-y-1 p-1">
                {rows.map(({ node, depth }) => {
                  if (node.kind === "directory") {
                    const includedCount = node.files.filter(
                      (file) => !excludedFiles.has(file.path),
                    ).length;
                    const expanded = !collapsed.has(node.path);
                    return (
                      <div
                        key={`directory:${node.path}`}
                        className="flex items-center gap-2 rounded-md py-1 pr-2 hover:bg-accent/50"
                        style={{ paddingLeft: 8 + depth * 16 }}
                      >
                        {isEditing && (
                          <Checkbox
                            aria-label={`Include directory ${node.path}`}
                            checked={includedCount === node.files.length}
                            indeterminate={includedCount > 0 && includedCount < node.files.length}
                            onCheckedChange={() =>
                              onExcludedFilesChange(toggleCommitFiles(node.files, excludedFiles))
                            }
                          />
                        )}
                        <button
                          type="button"
                          aria-label={node.path}
                          aria-expanded={expanded}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          onClick={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(node.path)) next.delete(node.path);
                              else next.add(node.path);
                              return next;
                            })
                          }
                        >
                          {expanded ? (
                            <ChevronDownIcon className="size-3 shrink-0" />
                          ) : (
                            <ChevronRightIcon className="size-3 shrink-0" />
                          )}
                          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <StartTruncatedPath
                            path={node.path}
                            displayPath={node.name}
                            className="font-mono"
                          />
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {node.files.length} {node.files.length === 1 ? "file" : "files"}
                          </span>
                        </button>
                      </div>
                    );
                  }
                  const file = node.file;
                  const isExcluded = excludedFiles.has(file.path);
                  return (
                    <div
                      key={`file:${file.path}`}
                      className="flex w-full items-center gap-2 rounded-md py-1 pr-2 font-mono hover:bg-accent/50"
                      style={{ paddingLeft: 8 + depth * 16 + (groupByDirectory ? 18 : 0) }}
                    >
                      {isEditing && (
                        <Checkbox
                          aria-label={`Include ${file.path}`}
                          checked={!isExcluded}
                          onCheckedChange={() => {
                            onExcludedFilesChange(toggleCommitFiles([file], excludedFiles));
                          }}
                        />
                      )}
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                        aria-label={`Open ${file.path}`}
                        disabled={!canOpenFile}
                        onClick={() => onOpenFile(file.path)}
                      >
                        <StartTruncatedPath
                          path={file.path}
                          displayPath={node.name}
                          className={`flex-1${isExcluded ? " text-muted-foreground" : ""}`}
                        />
                        <span className="shrink-0">
                          {isExcluded ? (
                            <span className="text-muted-foreground">Excluded</span>
                          ) : (
                            <>
                              <span className="text-diff-addition">
                                +{formatDiffCount(file.insertions)}
                              </span>
                              <span className="text-muted-foreground"> / </span>
                              <span className="text-diff-deletion">
                                -{formatDiffCount(file.deletions)}
                              </span>
                            </>
                          )}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
          <div className="flex justify-end font-mono">
            <span className="text-diff-addition">
              +{formatDiffCount(selectedFiles.reduce((sum, file) => sum + file.insertions, 0))}
            </span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-diff-deletion">
              -{formatDiffCount(selectedFiles.reduce((sum, file) => sum + file.deletions, 0))}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
