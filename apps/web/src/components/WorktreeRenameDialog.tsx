import { useEffect, useState } from "react";

import { useUiStateStore } from "../uiStateStore";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { useWorktreeRenameStore } from "../worktreeRenameStore";
import { Button } from "./ui/button";
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

/**
 * Global "Rename worktree" dialog. Mounted once in the app shell and driven by
 * useWorktreeRenameStore so any surface (sidebar context menu, bottom-bar
 * workspace label) can open it. Writes a cosmetic label keyed by worktree PATH
 * — shared by every thread on the same worktree, no disk move.
 */
export function WorktreeRenameDialog() {
  const targetPath = useWorktreeRenameStore((state) => state.targetPath);
  const closeWorktreeRename = useWorktreeRenameStore((state) => state.closeWorktreeRename);
  const setWorktreeLabel = useUiStateStore((state) => state.setWorktreeLabel);
  const [title, setTitle] = useState("");

  // Seed with the existing custom label only (blank when none) so the
  // placeholder can show the default name and a no-op Save keeps it.
  useEffect(() => {
    if (targetPath) {
      setTitle(useUiStateStore.getState().worktreeLabelByPath[targetPath] ?? "");
    }
  }, [targetPath]);

  const submit = () => {
    if (!targetPath) {
      return;
    }
    // An empty label clears the custom name, falling back to the path-derived
    // default — so we intentionally allow blank input here.
    setWorktreeLabel(targetPath, title);
    closeWorktreeRename();
  };

  return (
    <Dialog
      open={targetPath !== null}
      onOpenChange={(open) => {
        if (!open) {
          closeWorktreeRename();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rename worktree</DialogTitle>
          <DialogDescription>
            {targetPath
              ? `Set a display name for ${targetPath}. This is a label only and does not move the worktree on disk.`
              : "Set a display name for this worktree."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Worktree name</span>
            <Input
              aria-label="Worktree name"
              placeholder={targetPath ? formatWorktreePathForDisplay(targetPath) : undefined}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to reset to the default name. The label is shared by every thread on this
              worktree.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={closeWorktreeRename}>
            Cancel
          </Button>
          <Button onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
