import { useEffect, useState } from "react";

import { resolveWorktreeLabel, useUiStateStore } from "../uiStateStore";
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
 * workspace label) can open it. Writes a cosmetic label keyed by environment
 * and worktree path — shared by every thread on that worktree, no disk move.
 */
export function WorktreeRenameDialog() {
  const target = useWorktreeRenameStore((state) => state.target);
  const closeWorktreeRename = useWorktreeRenameStore((state) => state.closeWorktreeRename);
  const setWorktreeLabel = useUiStateStore((state) => state.setWorktreeLabel);
  const [title, setTitle] = useState("");

  // Seed with the existing custom label only (blank when none) so the
  // placeholder can show the default name and a no-op Save keeps it.
  useEffect(() => {
    if (target) {
      setTitle(
        resolveWorktreeLabel(
          useUiStateStore.getState(),
          target.environmentId,
          target.worktreePath,
        ) ?? "",
      );
    }
  }, [target]);

  const submit = () => {
    if (!target) {
      return;
    }
    // An empty label clears the custom name, falling back to the path-derived
    // default — so we intentionally allow blank input here.
    setWorktreeLabel(target.environmentId, target.worktreePath, title);
    closeWorktreeRename();
  };

  return (
    <Dialog
      open={target !== null}
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
            {target
              ? `Set a display name for ${target.worktreePath}. This is a label only and does not move the worktree on disk.`
              : "Set a display name for this worktree."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Worktree name</span>
            <Input
              aria-label="Worktree name"
              placeholder={target ? formatWorktreePathForDisplay(target.worktreePath) : undefined}
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
