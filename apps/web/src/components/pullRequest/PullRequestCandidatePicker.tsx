// Menu typeahead consumes search keystrokes; use a combobox.
import {
  draftChanges,
  isDraftSelected,
  toggleDraft,
  type SelectionDraft,
} from "@t3tools/client-runtime/pull-request-selection";
import { useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxSearchInput,
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
  matches,
  isSelected,
  single,
  emptyLabel,
  noMatchLabel,
  errorLabel,
  truncated,
  truncatedLabel,
  candidateKey,
  onCommit,
  children,
}: {
  icon: ReactNode;
  label: string;
  allowed: boolean;
  disabledReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  isPending: boolean;
  error: string | null;
  candidates: ReadonlyArray<T>;
  matches: (candidate: T, query: string) => boolean;
  isSelected: (candidate: T) => boolean;
  single: boolean;
  emptyLabel: string;
  noMatchLabel: string;
  errorLabel: string;
  truncated: boolean;
  truncatedLabel: string;
  candidateKey: (candidate: T) => string;
  /** Called once on close with what changed; the draft holds until it settles. */
  onCommit: (changes: { add: ReadonlyArray<T>; remove: ReadonlyArray<T> }) => Promise<void>;
  children: (candidate: T, selected: boolean) => ReactNode;
}) {
  const [draft, setDraft] = useState<SelectionDraft>(new Map());
  const [sending, setSending] = useState(false);
  const selections = candidates.map((candidate) => ({
    key: candidateKey(candidate),
    selected: isSelected(candidate),
    candidate,
  }));

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" aria-disabled="true" aria-label={label}>
              {icon}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{disabledReason}</TooltipPopup>
      </Tooltip>
    );
  }

  const shown = selections.filter((selection) => matches(selection.candidate, query));
  const keys = shown.map((selection) => selection.key);

  const commit = async () => {
    const changes = draftChanges(draft, selections);
    if (changes.add.length === 0 && changes.remove.length === 0) {
      setDraft(new Map());
      return;
    }
    setSending(true);
    await onCommit({
      add: changes.add.map((selection) => selection.candidate),
      remove: changes.remove.map((selection) => selection.candidate),
    });
    setSending(false);
    setDraft(new Map());
  };

  return (
    <Combobox
      items={keys}
      filteredItems={keys}
      filter={null}
      autoHighlight
      value={null}
      onValueChange={(key) => {
        const toggled = selections.find((selection) => selection.key === key);
        if (toggled) setDraft(toggleDraft(draft, selections, toggled, single));
      }}
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Item-press closure steals search focus and the next keystroke.
        if (!nextOpen && details.reason === "item-press") {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
        if (!nextOpen && !sending) void commit();
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
        <ComboboxSearchInput
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <ComboboxList className="max-h-72">
          {isPending ? (
            <PullRequestPeopleGhost rows={4} />
          ) : error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              {errorLabel} {error}
            </p>
          ) : shown.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0 ? noMatchLabel : emptyLabel}
            </p>
          ) : (
            shown.map((selection, index) => (
              <ComboboxItem
                key={selection.key}
                hideIndicator
                index={index}
                value={selection.key}
                disabled={sending}
              >
                {children(selection.candidate, isDraftSelected(draft, selection))}
              </ComboboxItem>
            ))
          )}
          {truncated ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{truncatedLabel}</p>
          ) : null}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
