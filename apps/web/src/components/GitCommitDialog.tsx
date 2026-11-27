import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { VcsStatusResult } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { FileDiffIcon, GitBranchIcon, GitBranchPlusIcon } from "lucide-react";
import { type SetStateAction, useId, useState } from "react";

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

/** Its own component so the per-file labels are translated only while the dialog's popup is mounted. */
function CommitFileRows({
  files,
  excludedFiles,
  canOpenFiles,
  onToggleFile,
  onOpenFile,
}: {
  files: VcsStatusResult["workingTree"]["files"];
  excludedFiles: ReadonlySet<string>;
  canOpenFiles: boolean;
  onToggleFile: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const gt = useGT();
  return (
    <>
      {files.map((file) => {
        const isExcluded = excludedFiles.has(file.path);
        const { name, directory } = splitFilePath(file.path);
        return (
          <div
            key={file.path}
            className={cn("flex h-8 min-w-0 items-center gap-2.5 px-2", isExcluded && "opacity-55")}
          >
            <Checkbox
              checked={!isExcluded}
              aria-label={gt("Include {path}", { path: file.path })}
              onCheckedChange={() => onToggleFile(file.path)}
            />
            <button
              type="button"
              className="flex min-w-0 flex-1 text-left enabled:cursor-pointer"
              aria-label={gt("Open {path}", { path: file.path })}
              disabled={!canOpenFiles}
              onClick={() => onOpenFile(file.path)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <FileDiffIcon aria-hidden className="size-3.5 shrink-0 text-diff-modified" />
                <span className="min-w-0 shrink truncate text-body text-foreground">{name}</span>
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
    </>
  );
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
  folderName = null,
  onSubmit,
  onOpenFile,
  retainedMessage = "",
  excludedFiles: controlledExcludedFiles,
  onExcludedFilesChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gitStatus: VcsStatusResult | null;
  isDefaultRef: boolean;
  canWriteSourceControl: boolean;
  /** A new branch also moves the thread onto it. */
  canChangeThreadBranch: boolean;
  canOpenFiles: boolean;
  /** The folder the commit runs in, named when a project has several. */
  folderName?: string | null;
  onSubmit: (submission: GitCommitDialogSubmission) => void;
  onOpenFile: (path: string) => void;
  /** A message a failed commit left behind, offered again when the dialog reopens. */
  retainedMessage?: string;
  /** Controlled exclusion set when the caller retains it across failed commits. */
  excludedFiles?: ReadonlySet<string>;
  onExcludedFilesChange?: (next: SetStateAction<ReadonlySet<string>>) => void;
}) {
  const gt = useGT();
  const branchFieldId = useId();
  const messageFieldId = useId();
  const [commitMessage, setCommitMessage] = useState("");
  const [uncontrolledExcludedFiles, setUncontrolledExcludedFiles] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const excludedFiles = controlledExcludedFiles ?? uncontrolledExcludedFiles;
  const setExcludedFiles = onExcludedFilesChange ?? setUncontrolledExcludedFiles;
  const [branchTarget, setBranchTarget] = useState<CommitBranchTarget>("current");

  // Every opening starts from the current branch and any retained failed message.
  const [openSeen, setOpenSeen] = useState(open);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      setCommitMessage(retainedMessage);
      if (controlledExcludedFiles === undefined) setUncontrolledExcludedFiles(new Set());
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
    { value: "current", label: refName ?? gt("(detached HEAD)") },
    { value: "new", label: gt("New branch") },
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
          <DialogTitle>{gt("Commit changes")}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {folderName ? (
            <p className="mb-3 flex min-w-0 gap-1.5 text-meta">
              <span className="shrink-0 text-muted-foreground">
                <T context="the folder Git actions run in">Folder</T>
              </span>
              <span className="min-w-0 truncate">{folderName}</span>
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={branchFieldId}>
              <T>Branch</T>
            </Label>
            <Select
              value={branchTarget}
              onValueChange={(value) => setBranchTarget(value === "new" ? "new" : "current")}
              items={branchItems}
            >
              <SelectTrigger id={branchFieldId} size="sm">
                {branchTarget === "new" ? <GitBranchPlusIcon /> : <GitBranchIcon />}
                <SelectValue />
                {branchTarget === "current" && isDefaultRef ? (
                  <Badge variant="warning">
                    {gt("default", { $context: "git ref badge, the default branch" })}
                  </Badge>
                ) : null}
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="current">
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranchIcon />
                    <span className="min-w-0 truncate">{refName ?? gt("(detached HEAD)")}</span>
                    {isDefaultRef ? (
                      <Badge variant="warning">
                        {gt("default", { $context: "git ref badge, the default branch" })}
                      </Badge>
                    ) : null}
                  </span>
                </SelectItem>
                <SelectItem value="new">
                  <span className="flex min-w-0 items-center gap-2">
                    <GitBranchPlusIcon />
                    <span className="shrink-0">{gt("New branch")}</span>
                    {refName ? (
                      <span className="min-w-0 truncate text-dim-foreground">
                        {gt("from {branch}", {
                          branch: refName,
                          $context: "the branch a new branch starts from",
                        })}
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label render={<span />}>
                <T>Files</T>
              </Label>
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
                    {allSelected ? gt("Exclude all") : gt("Include all")}
                  </InlineButton>
                </span>
              ) : null}
            </div>
            {allFiles.length === 0 ? (
              <p className="rounded-card surface-card-settings px-3 py-2 text-body text-muted-foreground">
                <T>No changed files.</T>
              </p>
            ) : (
              <div className="max-h-52 overflow-y-auto">
                <CommitFileRows
                  files={allFiles}
                  excludedFiles={excludedFiles}
                  canOpenFiles={canOpenFiles}
                  onToggleFile={toggleFile}
                  onOpenFile={onOpenFile}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={messageFieldId}>
              <T>Commit message (optional)</T>
            </Label>
            <Textarea
              id={messageFieldId}
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={gt("Leave empty to auto-generate")}
              size="sm"
            />
          </div>
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:items-center">
          <p className="flex flex-col gap-0.5 text-meta text-dim-foreground sm:mr-auto">
            <span>
              {gt(
                "{total, plural, one {{selected} of {total} file} other {{selected} of {total} files}}",
                { selected: selectedFiles.length, total: allFiles.length },
              )}
            </span>
            {excludedCount > 0 ? (
              <span>
                {gt("{count} excluded", {
                  count: excludedCount,
                  $context: "number of files left out of the commit",
                })}
              </span>
            ) : null}
          </p>
          <Button variant="secondary" size="standard" onClick={() => onOpenChange(false)}>
            <T>Cancel</T>
          </Button>
          <Button size="standard" disabled={submitDisabled} onClick={submit}>
            {branchTarget === "new" ? <T>Commit on new branch</T> : <T context="verb">Commit</T>}
            <DialogSubmitKbd />
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
