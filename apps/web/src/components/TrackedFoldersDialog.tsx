import {
  PROJECT_TRACKED_FOLDERS_MAX,
  type WorkspaceScanFoldersResult,
  type WorkspaceScannedFolder,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";
import { useState } from "react";

import {
  filterScannedFolders,
  TRACKED_FOLDERS_FILTER_THRESHOLD,
  trackedFolderDisplayPath,
} from "./TrackedFoldersDialog.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CheckboxMark } from "./ui/checkbox";
import {
  Dialog,
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

const NO_NEW_PATHS: ReadonlySet<string> = new Set();

/**
 * Mount it only while it is open. `add` offers the folders found for a new project, with a way to
 * add the project without any; `edit` confirms a rescan of an existing one.
 */
export function TrackedFoldersDialog(props: {
  readonly mode: "add" | "edit";
  readonly scan: WorkspaceScanFoldersResult;
  /** How many of the listed folders may be checked before the project's limit is reached. */
  readonly maxChecked: number;
  /** Listed paths the project does not track yet, marked in `edit` mode. */
  readonly newPaths?: ReadonlySet<string>;
  readonly busy?: boolean;
  readonly onConfirm: (checked: ReadonlyArray<WorkspaceScannedFolder>) => void;
  readonly onSkip?: () => void;
  readonly onClose: () => void;
}) {
  const { scan, mode } = props;
  const newPaths = props.newPaths ?? NO_NEW_PATHS;
  const [checkedPaths, setCheckedPaths] = useState<ReadonlySet<string>>(
    () => new Set(scan.folders.map((folder) => folder.path)),
  );
  const [filter, setFilter] = useState("");
  const showTools = scan.folders.length > TRACKED_FOLDERS_FILTER_THRESHOLD;
  const visibleFolders = filterScannedFolders(scan.folders, filter);
  const checked = scan.folders.filter((folder) => checkedPaths.has(folder.path));
  const overLimit = checked.length - props.maxChecked;
  const folderName = fileBasename(scan.workspaceRoot);
  const noun = scan.folders.every((folder) => folder.isGitRepository)
    ? scan.folders.length === 1
      ? "repository"
      : "repositories"
    : scan.folders.length === 1
      ? "folder"
      : "folders";

  const setVisibleChecked = (nextChecked: boolean) => {
    const next = new Set(checkedPaths);
    for (const folder of visibleFolders) {
      if (nextChecked) next.add(folder.path);
      else next.delete(folder.path);
    }
    setCheckedPaths(next);
  };
  const toggle = (path: string) => {
    const next = new Set(checkedPaths);
    if (!next.delete(path)) next.add(path);
    setCheckedPaths(next);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Repositories in {folderName}</DialogTitle>
          <DialogDescription>
            Found {scan.folders.length} {noun}
            {scan.codeWorkspaceFile
              ? `, including the ones ${fileBasename(scan.codeWorkspaceFile)} lists`
              : ""}
            . Tracked repositories get their own changes and review, and agents can work across
            them.
          </DialogDescription>
          {showTools ? (
            <div className="flex items-center gap-2 pt-1">
              <div className="min-w-0 flex-1">
                <Input
                  size="sm"
                  type="search"
                  aria-label="Filter repositories"
                  placeholder="Filter"
                  value={filter}
                  onChange={(event) => setFilter(event.currentTarget.value)}
                />
              </div>
              <Button size="xs" variant="ghost" onClick={() => setVisibleChecked(true)}>
                Select all
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setVisibleChecked(false)}>
                Select none
              </Button>
            </div>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {visibleFolders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches the filter.</p>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {visibleFolders.map((folder) => {
                const isChecked = checkedPaths.has(folder.path);
                return (
                  <li key={folder.path}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isChecked}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => toggle(folder.path)}
                    >
                      <CheckboxMark checked={isChecked} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{folder.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {trackedFolderDisplayPath(folder.path, scan.workspaceRoot)}
                        </span>
                      </span>
                      {mode === "edit" && newPaths.has(folder.path) ? (
                        <Badge size="sm" variant="info">
                          New
                        </Badge>
                      ) : null}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {folder.isGitRepository ? "Git" : "Folder"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogPanel>
        {overLimit > 0 ? (
          <p role="alert" className="px-6 pb-3 text-xs text-warning-foreground">
            A project can track up to {PROJECT_TRACKED_FOLDERS_MAX} folders. Uncheck {overLimit} to
            continue.
          </p>
        ) : null}
        <DialogFooter>
          {mode === "add" ? (
            <Button variant="outline" disabled={props.busy} onClick={props.onSkip}>
              Add without repositories
            </Button>
          ) : (
            <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
              Cancel
            </Button>
          )}
          <DialogAction
            disabled={props.busy || overLimit > 0}
            onClick={() => props.onConfirm(checked)}
          >
            {mode === "add" ? "Add project" : "Save"}
          </DialogAction>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
