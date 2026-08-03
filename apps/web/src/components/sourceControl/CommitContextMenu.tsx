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
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { MoreHorizontal } from "lucide-react";

import { Button } from "~/components/ui/button";

import { workingCopyBusyKey } from "./sourceControlPanel.logic";

export interface CommitContextMenuProps {
  readonly entry: WorkingCopyLogEntry;
  readonly detached: boolean;
  readonly dirty: boolean;
  /** fork: f4 F-06 — per-commit in-flight state, so a re-press cannot vanish. */
  readonly isBusy: (key: string) => boolean;
  readonly onCopy: (text: string, label?: string) => void;
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
  const busy = {
    tag: props.isBusy(workingCopyBusyKey.tag(entry.hash)),
    cherryPick: props.isBusy(workingCopyBusyKey.cherryPick(entry.hash)),
    checkout: props.isBusy(workingCopyBusyKey.checkout(entry.hash)),
    reset: props.isBusy(workingCopyBusyKey.reset(entry.hash)),
    revert: props.isBusy(workingCopyBusyKey.revert(entry.hash)),
  };

  return (
    <Menu>
      {/* fork: f4 redesign (M25) — the house trigger form, which brings the
          focus ring, the `pointer-coarse` 44px target and `disabled:opacity-64`
          that a hand-styled trigger loses. */}
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Actions for ${entry.shortHash}`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <MoreHorizontal />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={4} className="min-w-56">
        <MenuItem onClick={() => props.onCopy(entry.hash, "the commit hash")}>Copy hash</MenuItem>
        <MenuItem onClick={() => props.onCopy(entry.shortHash, "the short hash")}>
          Copy short hash
        </MenuItem>
        <MenuItem onClick={() => props.onCopy(entry.subject, "the commit subject")}>
          Copy subject
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => props.onFilterAuthor(entry.authorName)}>
          Filter by this author
        </MenuItem>
        <MenuItem disabled={busy.tag} onClick={() => props.onTag(entry)}>
          {busy.tag ? "Creating tag…" : "Create tag here…"}
        </MenuItem>
        <MenuItem disabled={busy.cherryPick} onClick={() => props.onCherryPick(entry)}>
          {busy.cherryPick ? "Cherry-picking…" : "Cherry-pick onto current"}
        </MenuItem>
        <MenuItem disabled={busy.checkout} onClick={() => props.onCheckout(entry)}>
          {busy.checkout ? "Checking out…" : "Checkout (detached)"}
        </MenuItem>
        <MenuSeparator />
        {/*
          fork: f4 redesign (M16 / m7) — all three modes always exist, with
          short labels inside a submenu.

          What this replaces: the soft item rendered `{reason ?? label}`, so a
          dirty tree turned three reset options into the single sentence
          "Commit or stash your changes first" and dropped the other two items
          entirely — the user could not see what had been there. The reason now
          sits above the group as a `MenuGroupLabel` and the items keep their
          labels and take `data-disabled:opacity-64`.
        */}
        <MenuSub>
          <MenuSubTrigger disabled={resetDisabledReason !== null || busy.reset}>
            Reset branch here
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-56">
            {resetDisabledReason === null ? null : (
              <MenuGroupLabel>{resetDisabledReason}</MenuGroupLabel>
            )}
            <MenuItem
              disabled={resetDisabledReason !== null || busy.reset}
              onClick={() => props.onReset(entry, "soft")}
            >
              Soft — keep staged + working
            </MenuItem>
            <MenuItem
              disabled={resetDisabledReason !== null || busy.reset}
              onClick={() => props.onReset(entry, "mixed")}
            >
              Mixed — keep working, unstage
            </MenuItem>
            <MenuItem
              className="text-destructive-foreground"
              disabled={resetDisabledReason !== null || busy.reset}
              onClick={() => props.onReset(entry, "hard")}
            >
              Hard — discard all changes
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        {isRootCommit ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              className="text-destructive-foreground"
              disabled={busy.revert}
              onClick={() => props.onRevert(entry)}
            >
              {busy.revert ? "Reverting…" : "Revert commit"}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
