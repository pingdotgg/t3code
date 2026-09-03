/**
 * The menu shell the reviewer and label pickers share: an icon trigger, a search box, and a
 * scrolling body that says when the list is loading, could not be read, is empty, or is not all
 * of it. The rows and the words are the caller's; the frame is the same either way.
 */
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestPeopleGhost } from "./PullRequestGhosts";

export function PullRequestCandidatePicker<T>({
  icon,
  label,
  allowed,
  disabledReason,
  open,
  onOpenChange,
  query,
  onQueryChange,
  searchLabel,
  isPending,
  error,
  candidates,
  emptyLabel,
  noMatchLabel,
  errorLabel,
  truncated,
  truncatedLabel,
  candidateKey,
  disabled,
  onSelect,
  children,
}: {
  icon: ReactNode;
  /** The trigger's accessible name; the button carries an icon alone. */
  label: string;
  /** False where the host would refuse this account's change. Disabled with the reason rather
   * than hidden: a control that vanishes teaches nobody why. */
  allowed: boolean;
  disabledReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  isPending: boolean;
  error: string | null;
  /** Already narrowed by the query; the shell only decides which state to show. */
  candidates: ReadonlyArray<T>;
  emptyLabel: string;
  noMatchLabel: string;
  /** Leads the host's own message, which follows it in the same sentence. */
  errorLabel: string;
  /** The host has more than the read asked for, so a name missing here may still be askable. */
  truncated: boolean;
  truncatedLabel: string;
  candidateKey: (candidate: T) => string;
  /** Every row locks while one change is in flight, so a second press cannot race the first. */
  disabled: boolean;
  onSelect: (candidate: T) => void;
  children: (candidate: T) => ReactNode;
}) {
  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label={label}>
              {icon}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{disabledReason}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label}>
            {icon}
          </Button>
        }
      />
      <MenuPopup align="start" side="bottom" className="w-72 p-0">
        <div className="border-b border-border/60 p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            size="compact"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {isPending ? (
            <PullRequestPeopleGhost rows={4} />
          ) : error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              {errorLabel} {error}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0 ? noMatchLabel : emptyLabel}
            </p>
          ) : (
            candidates.map((candidate) => (
              // Stays open on press: a change is confirmed by the row's own check turning over,
              // and a second label or reviewer is usually wanted right after the first.
              <MenuItem
                key={candidateKey(candidate)}
                closeOnClick={false}
                disabled={disabled}
                onClick={() => onSelect(candidate)}
                className="min-h-0 py-1.5 text-xs sm:min-h-0 sm:text-xs"
              >
                {children(candidate)}
              </MenuItem>
            ))
          )}
          {truncated ? (
            // Typing filters what arrived; it does not ask the host again, so this says what the
            // list is rather than offering a search that would find nothing further.
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{truncatedLabel}</p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
