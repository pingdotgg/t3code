/**
 * The per-commit context menu.
 *
 * The reset submenu is gated twice — on being on a branch at all, and on a
 * clean tree — with the reason stated on the disabled item rather than left for
 * the user to work out. `--hard` additionally goes through the top rung of the
 * safety ladder (typed confirmation); the other two modes are recoverable via
 * the reflog and do not.
 *
 * fork: f4 source-control panel
 */
import type { WorkingCopyLogEntry } from "@t3tools/contracts";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { MoreHorizontal } from "lucide-react";

export interface CommitContextMenuProps {
  readonly entry: WorkingCopyLogEntry;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly onCopy: (text: string) => void;
  readonly onFilterAuthor: (author: string) => void;
  readonly onTag: (entry: WorkingCopyLogEntry) => void;
  readonly onCherryPick: (entry: WorkingCopyLogEntry) => void;
  readonly onCheckout: (entry: WorkingCopyLogEntry) => void;
  readonly onReset: (entry: WorkingCopyLogEntry, mode: "soft" | "mixed" | "hard") => void;
  readonly onRevert: (entry: WorkingCopyLogEntry) => void;
}

export function CommitContextMenu(props: CommitContextMenuProps) {
  const { entry } = props;
  const resetDisabledReason = props.detached
    ? "Not on a branch"
    : props.dirty
      ? "Commit or stash your changes first"
      : null;
  const isRootCommit = entry.parents.length === 0;

  return (
    <Menu>
      <MenuTrigger
        className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`Actions for ${entry.shortHash}`}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={4} className="min-w-56">
        <MenuItem onClick={() => props.onCopy(entry.hash)}>Copy hash</MenuItem>
        <MenuItem onClick={() => props.onCopy(entry.shortHash)}>Copy short hash</MenuItem>
        <MenuItem onClick={() => props.onCopy(entry.subject)}>Copy subject</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => props.onFilterAuthor(entry.authorName)}>
          Filter by this author
        </MenuItem>
        <MenuItem onClick={() => props.onTag(entry)}>Create tag here…</MenuItem>
        <MenuItem onClick={() => props.onCherryPick(entry)}>Cherry-pick onto current</MenuItem>
        <MenuItem onClick={() => props.onCheckout(entry)}>Checkout (detached)</MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={resetDisabledReason !== null}
          onClick={() => props.onReset(entry, "soft")}
        >
          {resetDisabledReason ?? "Reset branch here — soft (keep staged + working)"}
        </MenuItem>
        {resetDisabledReason === null ? (
          <>
            <MenuItem onClick={() => props.onReset(entry, "mixed")}>
              Reset branch here — mixed (keep working, unstage)
            </MenuItem>
            <MenuItem
              className="text-destructive-foreground"
              onClick={() => props.onReset(entry, "hard")}
            >
              Reset branch here — hard (discard all changes)
            </MenuItem>
          </>
        ) : null}
        {isRootCommit ? null : (
          <>
            <MenuSeparator />
            <MenuItem className="text-destructive-foreground" onClick={() => props.onRevert(entry)}>
              Revert commit
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
