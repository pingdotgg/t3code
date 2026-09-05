/**
 * The menu shell the reviewer and label pickers share: an icon trigger, a search box, and a
 * scrolling body that says when the list is loading, could not be read, is empty, or is not all
 * of it. The rows and the words are the caller's; the frame is the same either way.
 *
 * The same combobox as the project and branch pickers, and dressed the same, rather than a menu:
 * a menu's typeahead claims every keypress to jump between rows, which a search box cannot share.
 */
import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
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

  const keys = candidates.map(candidateKey);

  return (
    <Combobox
      items={keys}
      // The caller narrows the list, so the combobox does no filtering of its own.
      filteredItems={keys}
      filter={null}
      autoHighlight
      value={null}
      onValueChange={(key) => {
        const candidate = candidates.find((entry) => candidateKey(entry) === key);
        if (candidate) onSelect(candidate);
      }}
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Stays open on a pick: a change is confirmed by the row's own check turning over, and a
        // second label or reviewer is usually wanted right after the first. Cancelled rather than
        // ignored, so the combobox also skips its own close work: freezing the query and returning
        // focus to the trigger, either of which would take the next keystroke away from the box.
        if (!nextOpen && details.reason === "item-press") {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <ComboboxTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label}>
            {icon}
          </Button>
        }
      />
      <ComboboxPopup align="start" side="bottom" className="w-72">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              aria-label={searchLabel}
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder={searchLabel}
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
          </div>
        </div>
        <ComboboxList className="max-h-72">
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
            candidates.map((candidate, index) => (
              <ComboboxItem
                key={keys[index]}
                hideIndicator
                index={index}
                value={keys[index]}
                disabled={disabled}
                className="min-h-0 py-1.5 text-xs sm:min-h-0 sm:text-xs"
                contentClassName="flex min-w-0 items-center gap-2"
              >
                {children(candidate)}
              </ComboboxItem>
            ))
          )}
          {truncated ? (
            // Typing filters what arrived; it does not ask the host again, so this says what the
            // list is rather than offering a search that would find nothing further.
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{truncatedLabel}</p>
          ) : null}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
