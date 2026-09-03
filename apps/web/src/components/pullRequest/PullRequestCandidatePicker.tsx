/**
 * The menu shell the reviewer and label pickers share: an icon trigger, a search box, and a
 * scrolling body that says when the list is loading, could not be read, is empty, or is not all
 * of it. The rows and the words are the caller's; the frame is the same either way.
 *
 * Built on a popover and the command list rather than a menu: a menu's typeahead claims every
 * keypress to jump between rows, which is exactly what a search box cannot share.
 */
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label}>
            {icon}
          </Button>
        }
      />
      <PopoverPopup
        align="start"
        side="bottom"
        className="w-72 before:hidden [--viewport-inline-padding:0]"
        viewportClassName="overflow-hidden p-0"
      >
        {/* The caller narrows the list, so the command does no filtering of its own. */}
        <Command mode="none" value={query} onValueChange={onQueryChange}>
          <CommandInput
            wrapperClassName="border-b border-border/60 px-2 py-2 [&_[data-slot=autocomplete-start-addon]]:ps-2"
            className="*:data-[slot=autocomplete-input]:ps-8!"
            placeholder={searchLabel}
            aria-label={searchLabel}
            size="sm"
          />
          <CommandList className="max-h-72 not-empty:p-1">
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
                <CommandItem
                  key={candidateKey(candidate)}
                  value={candidateKey(candidate)}
                  disabled={disabled}
                  onClick={() => onSelect(candidate)}
                  className="min-h-0 cursor-pointer gap-2 py-1.5 text-xs sm:min-h-0 sm:text-xs"
                >
                  {children(candidate)}
                </CommandItem>
              ))
            )}
            {truncated ? (
              // Typing filters what arrived; it does not ask the host again, so this says what the
              // list is rather than offering a search that would find nothing further.
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{truncatedLabel}</p>
            ) : null}
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
}
