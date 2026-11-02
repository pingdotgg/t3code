import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { VcsStatusResult } from "@t3tools/contracts";
import { FileDiffIcon, GitBranchIcon, GitBranchPlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { DialogSubmitKbd, isDialogSubmitShortcut } from "./DialogSubmitShortcut";
import { StartTruncatedPath } from "./StartTruncatedPath";
import { Badge } from "./ui/badge";
import { Button, InlineButton } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

type CommitBranchTarget = "current" | "new";

export interface GitCommitDialogSubmission {
  readonly commitMessage: string | null;
  /** Absent when every changed file is included. */
  readonly filePaths: ReadonlyArray<string> | null;
  /** Commit on a new, automatically named branch instead of the current one. */
  readonly featureBranch: boolean;
}

function splitFilePath(path: string): { readonly name: string; readonly directory: string } {
  const separator = path.lastIndexOf("/");
  return separator === -1
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

/**
 * Review and commit the working tree: pick the branch to commit on, include or exclude files,
 * and write an optional message. The caller runs the commit.
 */
export function GitCommitDialog({
  open,
  onOpenChange,
  gitStatus,
  isDefaultRef,
  canWriteSourceControl,
  canChangeThreadBranch,
  canOpenFiles,
  onSubmit,
  onOpenFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gitStatus: VcsStatusResult | null;
  isDefaultRef: boolean;
  canWriteSourceControl: boolean;
  /** A new branch also moves the thread onto it. */
  canChangeThreadBranch: boolean;
  canOpenFiles: boolean;
  onSubmit: (submission: GitCommitDialogSubmission) => void;
  onOpenFile: (path: string) => void;
}) {
  const branchFieldId = useId();
  const messageFieldId = useId();
  const [commitMessage, setCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [branchTarget, setBranchTarget] = useState<CommitBranchTarget>("current");

  // Every opening starts from the whole working tree on the current branch.
  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      setCommitMessage("");
      setExcludedFiles(new Set());
      setBranchTarget("current");
    }
  }

  const allFiles = gitStatus?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = selectedFiles.length === allFiles.length;
  const noneSelected = selectedFiles.length === 0;
  const excludedCount = allFiles.length - selectedFiles.length;
  const refName = gitStatus?.refName ?? null;
  const branchItems = [
    { value: "current", label: refName ?? "(detached HEAD)" },
    { value: "new", label: "New branch" },
  ];

  const toggleFile = (path: string) => {
    setExcludedFiles((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submitDisabled =
    noneSelected || !canWriteSourceControl || (branchTarget === "new" && !canChangeThreadBranch);
  const submit = () => {
    if (submitDisabled) return;
    const trimmedMessage = commitMessage.trim();
    onSubmit({
      commitMessage: trimmedMessage.length > 0 ? trimmedMessage : null,
      filePaths: allSelected ? null : selectedFiles.map((file) => file.path),
      featureBranch: branchTarget === "new",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="sm:max-w-115"
        onKeyDown={(event) => {
          if (!isDialogSubmitShortcut(event)) return;
          event.preventDefault();
          submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={branchFieldId}>Branch</Label>
            <Select
              value={branchTarget}
              onValueChange={(value) => setBranchTarget(value === "new" ? "new" : "current")}
              items={branchItems}
            >
              <SelectTrigger id={branchFieldId} size="sm">
                {branchTarget === "new" ? <GitBranchPlusIcon /> : <GitBranchIcon />}
                <SelectValue />
                {branchTarget === "current" && isDefaultRef ? (
                  <Badge variant="warning">default</Badge>
                ) : null}
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="current">
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranchIcon />
                    <span className="min-w-0 truncate">{refName ?? "(detached HEAD)"}</span>
                    {isDefaultRef ? <Badge variant="warning">default</Badge> : null}
                  </span>
                </SelectItem>
                <SelectItem value="new">
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranchPlusIcon />
                    <span className="shrink-0">New branch</span>
                    {refName ? (
                      <span className="min-w-0 truncate text-dim-foreground">from {refName}</span>
                    ) : null}
                  </span>
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label render={<span />}>Files</Label>
              {allFiles.length > 1 ? (
                <span className="text-meta">
                  <InlineButton
                    tone="muted"
                    onClick={() =>
                      setExcludedFiles(
                        allSelected ? new Set(allFiles.map((file) => file.path)) : new Set(),
                      )
                    }
                  >
                    {allSelected ? "Exclude all" : "Include all"}
                  </InlineButton>
                </span>
              ) : null}
            </div>
            {allFiles.length === 0 ? (
              <p className="rounded-card surface-card-settings px-3 py-2 text-body text-muted-foreground">
                No changed files.
              </p>
            ) : (
              <div className="max-h-52 overflow-y-auto">
                {allFiles.map((file) => {
                  const isExcluded = excludedFiles.has(file.path);
                  const { name, directory } = splitFilePath(file.path);
                  return (
                    <div
                      key={file.path}
                      className={cn(
                        "flex h-8 min-w-0 items-center gap-2.5 px-2",
                        isExcluded && "opacity-55",
                      )}
                    >
                      <Checkbox
                        checked={!isExcluded}
                        aria-label={`Include ${file.path}`}
                        onCheckedChange={() => toggleFile(file.path)}
                      />
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 text-left enabled:cursor-pointer"
                        aria-label={`Open ${file.path}`}
                        disabled={!canOpenFiles}
                        onClick={() => onOpenFile(file.path)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2.5">
                          <FileDiffIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-diff-modified"
                          />
                          <span className="min-w-0 shrink truncate text-body text-foreground">
                            {name}
                          </span>
                          {directory ? (
                            <StartTruncatedPath
                              path={directory}
                              className="min-w-0 flex-1 text-meta text-dim-foreground"
                            />
                          ) : (
                            <span className="flex-1" />
                          )}
                        </span>
                      </button>
                      <span
                        className={cn(
                          "shrink-0 font-mono text-meta tabular-nums",
                          isExcluded ? "text-dim-foreground" : "text-muted-foreground",
                        )}
                      >
                        {file.insertions > 0 ? `+${formatDiffCount(file.insertions)}` : ""}
                        {file.insertions > 0 && file.deletions > 0 ? " " : ""}
                        {file.deletions > 0 ? `−${formatDiffCount(file.deletions)}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={messageFieldId}>Commit message (optional)</Label>
            <Textarea
              id={messageFieldId}
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Leave empty to auto-generate"
              size="sm"
            />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:items-center">
          <p className="text-meta text-dim-foreground sm:mr-auto">
            {selectedFiles.length} of {allFiles.length} {allFiles.length === 1 ? "file" : "files"}
            {excludedCount > 0 ? ` · ${excludedCount} excluded` : ""}
          </p>
          <Button variant="secondary" size="standard" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="standard" disabled={submitDisabled} onClick={submit}>
            {branchTarget === "new" ? "Commit on new branch" : "Commit"}
            <DialogSubmitKbd />
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
