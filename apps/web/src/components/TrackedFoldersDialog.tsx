import type { ProjectTrackedFolder, WorkspaceScanFoldersResult } from "@t3tools/contracts";
import { useState } from "react";
import { create } from "zustand";

import {
  SCAN_PRESELECT_MAX,
  filterScannedFolders,
  folderKindLabel,
  initialScanSelection,
  scannedFoldersTitle,
  trackedFoldersFromScan,
} from "../lib/multiRepo";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { MiddleTruncate } from "./ui/middle-truncate";

interface TrackedFoldersRequest {
  readonly title?: string;
  readonly submitLabel: string;
  readonly workspaceRoot: string;
  readonly scan: WorkspaceScanFoldersResult;
  readonly resolve: (folders: ProjectTrackedFolder[] | null) => void;
}

const useRequest = create<{ request: TrackedFoldersRequest | null; session: number }>(() => ({
  request: null,
  session: 0,
}));

/**
 * Asks which scanned folders a project tracks. Resolves the checked folders, or null when the
 * user cancels. A newer request cancels an open one.
 */
export function chooseTrackedFolders(
  input: Omit<TrackedFoldersRequest, "resolve">,
): Promise<ProjectTrackedFolder[] | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useRequest.setState((state) => ({
      request: { ...input, resolve },
      session: state.session + 1,
    }));
  });
}

function finish(folders: ProjectTrackedFolder[] | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(folders);
}

export function TrackedFoldersDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  return request ? <TrackedFoldersDialog key={session} request={request} /> : null;
}

function TrackedFoldersDialog({ request }: { request: TrackedFoldersRequest }) {
  const { folders } = request.scan;
  const [checked, setChecked] = useState(() => initialScanSelection(folders));
  const [query, setQuery] = useState("");
  const visible = filterScannedFolders(folders, query);
  const allVisibleChecked = visible.every((folder) => checked.has(folder.path));

  const setFolders = (paths: ReadonlyArray<string>, include: boolean) => {
    const next = new Set(checked);
    for (const path of paths) {
      if (include) next.add(path);
      else next.delete(path);
    }
    setChecked(next);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            finish(trackedFoldersFromScan(folders, checked));
          }}
        >
          <DialogHeader>
            <DialogTitle>{request.title ?? scannedFoldersTitle(folders)}</DialogTitle>
            <DialogDescription>
              New worktree threads get a worktree of each checked repo.
              {request.scan.codeWorkspaceFile
                ? ` Includes folders from ${request.scan.codeWorkspaceFile}.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex items-center gap-2">
              {folders.length > SCAN_PRESELECT_MAX ? (
                <Input
                  size="sm"
                  placeholder="Filter"
                  aria-label="Filter folders"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              ) : (
                <span className="flex-1" />
              )}
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {checked.size} of {folders.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={visible.length === 0}
                onClick={() =>
                  setFolders(
                    visible.map((folder) => folder.path),
                    !allVisibleChecked,
                  )
                }
              >
                {allVisibleChecked && visible.length > 0 ? "None" : "All"}
              </Button>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border">
              {visible.map((folder) => {
                const kind = folderKindLabel(folder, request.workspaceRoot);
                return (
                  <label
                    key={folder.path}
                    className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm not-last:border-b"
                  >
                    <Checkbox
                      checked={checked.has(folder.path)}
                      onCheckedChange={(next) => setFolders([folder.path], next)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{folder.name}</span>
                      <span className="flex min-w-0 font-mono text-muted-foreground text-xs">
                        <MiddleTruncate value={folder.path} />
                      </span>
                    </span>
                    {kind ? (
                      <span className="shrink-0 text-muted-foreground text-xs">{kind}</span>
                    ) : null}
                  </label>
                );
              })}
              {visible.length === 0 ? (
                <p className="px-2.5 py-1.5 text-muted-foreground text-xs">No matching folders.</p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">{request.submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
